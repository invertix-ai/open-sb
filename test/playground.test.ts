// The playground's own logic, without the network: statistics, the event log and its SSE replay, the
// localhost guard, cleanup across providers, the agent tool loop driven by a fake Anthropic client, and keys
// saved from the UI (stored in a temporary HOME).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { defineProvider, type Core, type SandboxInfo } from "../src/index.ts";
import { addUsage, echoContent, runAgentLoop, validateRunCommand, validateWriteFile, type AgentClient, type ToolExecutor } from "../playground/agent-loop.ts";
import { createApp } from "../playground/app.ts";
import { CredentialError, credentialsPath, loadSaved, mergedEnv, removeValues, saveValues, validateValues } from "../playground/credentials.ts";
import { LABEL, runAcrossProviders } from "../playground/harness.ts";
import { Run, type PlaygroundEvent } from "../playground/runs.ts";
import { histogram, percentile, summarize } from "../playground/stats.ts";

test("percentiles interpolate, summaries and histograms cover every value", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10, 20], 95), 19.5);
  assert.ok(Number.isNaN(percentile([], 50)));
  assert.deepEqual(summarize([2, 4, 6]), { n: 3, min: 2, max: 6, mean: 4, p50: 4, p95: 5.8 });
  const bins = histogram([0, 1, 2, 3, 10], 5);
  assert.equal(bins.length, 5);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 5);
  assert.equal(bins.at(-1)!.count, 1, "the largest value lands in the last bin");
  assert.deepEqual(histogram([7, 7], 3).map(bin => bin.count), [2, 0, 0], "equal values do not divide by zero");
});

// ---------------------------------------------------------------- event log, SSE and guards

async function withServer(fn: (port: number, app: ReturnType<typeof createApp>) => Promise<void>, env: Record<string, string> = {}) {
  const server = http.createServer();
  const app = createApp({ env, port: () => (server.address() as AddressInfo).port });
  server.on("request", app.handler);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try { await fn((server.address() as AddressInfo).port, app); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    http.get({ host: "127.0.0.1", port, path, headers }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => done({ status: response.statusCode ?? 0, body }));
    }).on("error", fail);
  });
}

const sseEvents = (body: string) => body.split("\n\n").filter(block => block.includes("data: "))
  .map(block => JSON.parse(block.slice(block.indexOf("data: ") + 6)) as PlaygroundEvent);

test("runs redact secrets and replay every event to late subscribers over SSE", async () => {
  await withServer(async (port, app) => {
    const run = new Run("speed", ["docker"], {}, text => text.split("sk-very-secret").join("[redacted]"));
    app.runs.add(run);
    run.emit({ type: "log", message: "key sk-very-secret leaked?" });
    run.emit({ type: "metric", provider: "docker", name: "create_ms", value: 12 });

    // A live subscriber gets the history, then new events, and the stream ends with `done`.
    const live = get(port, `/api/runs/${run.id}/events`);
    await new Promise(done => setTimeout(done, 50));
    run.emit({ type: "status", provider: "docker", status: "done" });
    run.finish("done");
    const first = sseEvents((await live).body);
    assert.deepEqual(first.map(event => event.type), ["log", "metric", "status", "done"]);
    assert.equal(first[0]!.message, "key [redacted] leaked?");

    // A late subscriber gets the same events; Last-Event-ID resumes after the given index.
    assert.deepEqual(sseEvents((await get(port, `/api/runs/${run.id}/events`)).body), first);
    assert.deepEqual(sseEvents((await get(port, `/api/runs/${run.id}/events`, { "Last-Event-ID": "1" })).body).map(event => event.type), ["status", "done"]);

    const exported = JSON.parse((await get(port, `/api/runs/${run.id}/export`)).body);
    assert.equal(exported.events.length, 4);
    run.emit({ type: "log", message: "after the end" });
    assert.equal(run.events.length, 4, "a finished run takes no more events");
  });
});

test("requests for other hosts or from other origins are refused", async () => {
  await withServer(async port => {
    assert.equal((await get(port, "/api/runs", { Host: "attacker.example" })).status, 403);
    assert.equal((await get(port, "/api/runs", { Origin: "http://attacker.example" })).status, 403);
    assert.equal((await get(port, "/api/runs", { Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status, 200);
  });
});

// ---------------------------------------------------------------- harness

function fakeProvider(name: string, behaviour: { failCreate?: boolean } = {}) {
  const sandboxes = new Map<string, SandboxInfo>();
  let next = 0;
  const core: Core = {
    async create(options = {}) {
      if (behaviour.failCreate) throw new Error("boom");
      const info: SandboxInfo = { id: `${name}-${++next}`, state: "running", labels: options.labels ?? {} };
      sandboxes.set(info.id, info);
      return info;
    },
    get: async id => sandboxes.get(id) ?? null,
    list: async (filter = {}) => [...sandboxes.values()].filter(info => Object.entries(filter.labels ?? {}).every(([k, v]) => info.labels[k] === v)),
    destroy: async id => { sandboxes.delete(id); },
    exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
    readFile: async () => new Uint8Array(), writeFile: async () => {},
  };
  return { provider: defineProvider({ ...core, name, capabilities: [] as const }), sandboxes };
}

test("one provider failing does not stop the others, and every labelled sandbox is destroyed", async () => {
  const good = fakeProvider("good"), bad = fakeProvider("bad", { failCreate: true });
  const run = new Run("load", ["good", "bad"], {});
  await runAcrossProviders(run, [{ module: "good", title: "Good", provider: good.provider }, { module: "bad", title: "Bad", provider: bad.provider }], async ctx => {
    // Leaves its sandbox behind on purpose: the sweep must remove it.
    const info = await ctx.provider.create({ labels: { [LABEL]: ctx.runId } });
    return { id: info.id };
  });
  assert.deepEqual(run.results.good, { ok: true, ms: (run.results.good as { ms: number }).ms, id: "good-1" });
  assert.equal((run.results.bad as { ok: boolean }).ok, false);
  assert.equal(good.sandboxes.size, 0, "the sweep destroyed the sandbox the test left behind");
  assert.ok(run.events.some(event => event.type === "error" && event.provider === "bad"));
});

// ---------------------------------------------------------------- agent loop

function message(content: unknown[], stopReason: string, extra: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, iterations: null },
    ...extra,
  } as unknown as BetaMessage;
}

function fakeClient(responses: BetaMessage[]) {
  const requests: Record<string, unknown>[] = [];
  const client: AgentClient = {
    beta: { messages: { create: async body => {
      requests.push(structuredClone(body) as unknown as Record<string, unknown>);
      const next = responses.shift();
      if (!next) throw new Error("no more scripted responses");
      return next;
    } } },
  };
  return { client, requests };
}

function recordingTools() {
  const calls: string[] = [];
  const tools: ToolExecutor = {
    runCommand: async input => { calls.push(`run:${input.command}`); return { content: "exit code: 0\nstdout:\nhi" }; },
    writeFile: async input => { calls.push(`write:${input.path}`); return { content: "ok" }; },
  };
  return { tools, calls };
}

const loop = (client: AgentClient, tools: ToolExecutor, model = "claude-opus-5-5", maxTurns = 25) => runAgentLoop({
  client, model, effort: "medium", prompt: "do it", system: "sys", tools, maxTurns, timeLimitMs: 60_000, signal: new AbortController().signal,
});

test("the agent loop runs parallel tool calls, returns all results in one message and stops at end_turn", async () => {
  const { client, requests } = fakeClient([
    message([
      { type: "text", text: "Working on it" },
      { type: "tool_use", id: "t1", name: "run_command", input: { command: "echo hi" } },
      { type: "tool_use", id: "t2", name: "write_file", input: { path: "relative.txt", content: "x" } },
      { type: "tool_use", id: "t3", name: "write_file", input: { path: "/tmp/a.txt", content: "x" } },
    ], "tool_use"),
    message([{ type: "text", text: "Done." }], "end_turn"),
  ]);
  const { tools, calls } = recordingTools();
  const result = await loop(client, tools);

  assert.equal(result.stop, "end_turn");
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.finalText, "Done.");
  assert.deepEqual(calls.sort(), ["run:echo hi", "write:/tmp/a.txt"], "invalid input never reaches the sandbox");

  const first = requests[0]!;
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.tool_choice, { type: "auto" });
  assert.deepEqual(first.output_config, { effort: "medium" });
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first.fallbacks, "default");
  assert.equal("thinking" in first, false, "thinking is omitted (adaptive by default)");
  for (const tool of first.tools as { strict: boolean; input_schema: { additionalProperties: boolean } }[]) {
    assert.equal(tool.strict, true);
    assert.equal(tool.input_schema.additionalProperties, false);
  }

  const messages = requests[1]!.messages as { role: string; content: { type: string; tool_use_id: string; is_error?: boolean }[] }[];
  const results = messages.at(-1)!;
  assert.equal(results.role, "user");
  assert.deepEqual(results.content.map(block => [block.type, block.tool_use_id, block.is_error ?? false]),
    [["tool_result", "t1", false], ["tool_result", "t2", true], ["tool_result", "t3", false]]);

  // Two responses at 1000 input, 100 output and 500 cache-read tokens on Opus 5.5 ($4 / $20 / $0.20 per MTok).
  assert.deepEqual({ ...result.usage, costUsd: Math.round(result.usage.costUsd * 1e6) / 1e6 }, { input: 2000, output: 200, cacheRead: 1000, cacheWrite: 0, costUsd: 0.0122 });
});

test("the agent loop never runs tools after a refusal or max_tokens, and stops at the turn limit", async () => {
  const toolCall = { type: "tool_use", id: "t1", name: "run_command", input: { command: "rm -rf /tmp/x" } };
  for (const stopReason of ["refusal", "max_tokens"]) {
    const { client } = fakeClient([message([toolCall], stopReason)]);
    const { tools, calls } = recordingTools();
    assert.equal((await loop(client, tools)).stop, stopReason);
    assert.deepEqual(calls, []);
  }
  const { client, requests } = fakeClient([message([toolCall], "tool_use"), message([toolCall], "tool_use")]);
  const result = await loop(client, recordingTools().tools, "claude-haiku-5-5", 2);
  assert.equal(result.stop, "max_turns");
  assert.equal("fallbacks" in requests[0]!, false, "Haiku 5.5 has no server-side fallback");
});

test("after a fallback only text from before the boundary is echoed, and fallback usage is priced per model", () => {
  const content = [
    { type: "thinking", thinking: "", signature: "s" },
    { type: "text", text: "partial" },
    { type: "tool_use", id: "old", name: "run_command", input: {} },
    { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
    { type: "tool_use", id: "new", name: "run_command", input: {} },
  ];
  assert.deepEqual(echoContent(content as never).map(block => block.type), ["text", "fallback", "tool_use"]);

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  addUsage(usage, message([], "end_turn", { usage: {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    iterations: [
      { type: "message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ],
  } } as never), "claude-opus-5-5");
  assert.equal(usage.costUsd, 9, "$4 on Opus 5.5 plus $5 on the Opus 4.8 fallback");
});

test("tool inputs are validated before they run", () => {
  assert.equal(validateRunCommand({ command: "ls" }).ok, true);
  assert.equal(validateRunCommand({ command: "" }).ok, false);
  assert.equal(validateRunCommand({ command: "ls", timeout: 0 }).ok, false);
  assert.equal(validateRunCommand({ command: "ls", cwd: "tmp" }).ok, false);
  assert.equal(validateRunCommand({ command: "ls", extra: 1 }).ok, false);
  assert.equal(validateWriteFile({ path: "/tmp/x", content: "" }).ok, true);
  assert.equal(validateWriteFile({ path: "/tmp/", content: "" }).ok, false);
  assert.equal(validateWriteFile({ path: "/tmp/x", content: 3 }).ok, false);
});

// ---------------------------------------------------------------- saved keys

async function withHome(fn: (home: string) => Promise<void>) {
  const previous = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "open-sb-home-"));
  process.env.HOME = home;
  try { await fn(home); }
  finally { process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
}

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: body === undefined ? {} : { "Content-Type": "application/json" } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => done({ status: response.statusCode ?? 0, body: text }));
    });
    req.on("error", fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("saved keys round-trip through a 0600 file in a 0700 directory, and removing deletes them", async () => {
  await withHome(async home => {
    assert.deepEqual(loadSaved(), {});
    saveValues("e2b", validateValues("e2b", { E2B_API_KEY: "  e2b_fake_0123456789  ", E2B_TEMPLATE: "" }));
    saveValues("fly", { FLY_REGION: "ams" });
    const file = join(home, ".config", "open-sb", "credentials.json");
    assert.equal(credentialsPath(), file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".config", "open-sb")).mode & 0o777, 0o700);
    assert.deepEqual(loadSaved(), { e2b: { E2B_API_KEY: "e2b_fake_0123456789" }, fly: { FLY_REGION: "ams" } }, "values are trimmed and empty ones dropped");
    removeValues("e2b");
    assert.deepEqual(loadSaved(), { fly: { FLY_REGION: "ams" } });
  });
});

test("only a provider's own variables are accepted, within length limits", async () => {
  assert.throws(() => validateValues("e2b", { PATH: "/bin" }), CredentialError);
  assert.throws(() => validateValues("e2b", { DAYTONA_API_KEY: "x" }), CredentialError, "another provider's variable");
  assert.throws(() => validateValues("e2b", { E2B_API_KEY: "x".repeat(5000) }), CredentialError);
  assert.throws(() => validateValues("e2b", { E2B_API_KEY: "a\nb" }), CredentialError);
  assert.throws(() => validateValues("nope", {}), CredentialError);
  assert.deepEqual(validateValues("claude", { ANTHROPIC_API_KEY: "sk-ant-fake" }), { ANTHROPIC_API_KEY: "sk-ant-fake" });
  await withHome(async () => withServer(async port => {
    const rejected = await request(port, "PUT", "/api/credentials/e2b", { values: { NODE_OPTIONS: "--inspect" } });
    assert.equal(rejected.status, 400);
    assert.match(JSON.parse(rejected.body).error, /not a variable of e2b/);
    assert.equal((await request(port, "PUT", "/api/credentials/e2b")).status, 415, "bodies must be JSON");
    assert.deepEqual(loadSaved(), {}, "nothing was written");
  }));
});

test("saved values win over the environment, the API reports only where a value comes from, and runs redact them", async () => {
  await withHome(async () => {
    const env = { E2B_API_KEY: "env_value_aaaaaaaa", DAYTONA_API_KEY: "env_daytona_bbbbbbbb" };
    saveValues("e2b", { E2B_API_KEY: "saved_value_cccccccc" });
    const merged = mergedEnv(env);
    assert.equal(merged.E2B_API_KEY, "saved_value_cccccccc");
    assert.equal(merged.DAYTONA_API_KEY, "env_daytona_bbbbbbbb");

    await withServer(async (port, app) => {
      const response = await get(port, "/api/credentials");
      assert.equal(response.status, 200);
      for (const value of [...Object.values(env), "saved_value_cccccccc"]) assert.ok(!response.body.includes(value), "no value is ever sent back");
      const statuses = JSON.parse(response.body).credentials as { module: string; fields: { name: string; status: string }[] }[];
      const field = (module: string, name: string) => statuses.find(entry => entry.module === module)!.fields.find(entry => entry.name === name)!.status;
      assert.equal(field("e2b", "E2B_API_KEY"), "saved");
      assert.equal(field("daytona", "DAYTONA_API_KEY"), "env");
      assert.equal(field("modal", "MODAL_TOKEN_ID"), "unset");

      const providers = JSON.parse((await get(port, "/api/providers")).body) as { providers: { module: string; available: boolean }[] };
      assert.equal(providers.providers.find(entry => entry.module === "e2b")!.available, true, "a saved key makes the provider available without a restart");

      // A key saved after the server started is redacted too.
      saveValues("claude", { ANTHROPIC_API_KEY: "sk-ant-later-dddddddd" });
      assert.equal(app.redact("a sk-ant-later-dddddddd b saved_value_cccccccc c"), "a [redacted] b [redacted] c");
      const deleted = await request(port, "DELETE", "/api/credentials/e2b");
      assert.equal(deleted.status, 200);
      assert.equal(loadSaved().e2b, undefined);
    }, env);
  });
});
