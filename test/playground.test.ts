// The playground's own logic, without the network: statistics, the event log and its SSE replay, the
// localhost guard, cleanup across providers, the agent tool loops driven by fake Anthropic and OpenAI clients,
// and keys saved from the UI (stored in a temporary HOME).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Response } from "openai/resources/responses/responses";
import { defineProvider, type Core, type SandboxInfo } from "../src/index.ts";
import { addUsage, echoContent, runAgentLoop, validateRunCommand, validateWriteFile, type AgentClient, type ToolExecutor } from "../playground/agent-loop.ts";
import { OPENAI_TOOLS, runOpenAIAgentLoop, type OpenAIAgentClient } from "../playground/openai-loop.ts";
import { agent, setOpenAIClientFactory } from "../playground/tests/agent.ts";
import { secretValues } from "../playground/providers.ts";
import { createApp } from "../playground/app.ts";
import { CredentialError, credentialsPath, loadSaved, mergedEnv, removeValues, saveValues, validateValues } from "../playground/credentials.ts";
import { LABEL, live, runAcrossProviders } from "../playground/harness.ts";
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

test("desktop reconnect is restricted to sandboxes of an active run, and exports omit viewer credentials", async () => {
  await withServer(async (port, app) => {
    const run = new Run("desktop", ["daytona"], {});
    app.runs.add(run);
    const previous = live.get("daytona");
    live.set("daytona", new Map([["owned", run.id], ["unrelated", "other-run"]]));
    const reconnect = (sandboxId: string, provider = "daytona") => fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/desktop`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, sandboxId }),
    });
    try {
      assert.equal((await reconnect("unrelated")).status, 403);
      assert.equal((await reconnect("owned", "boat")).status, 403);
      run.emit({ type: "output", kind: "desktop", provider: "daytona", sandboxId: "owned", url: "https://private-viewer.example/", websocketUrl: "wss://private-socket.example/" });
      const exported = (await get(port, `/api/runs/${run.id}/export`)).body;
      assert.ok(!exported.includes("private-viewer") && !exported.includes("private-socket"), "bearer URLs must not be saved in exports");
      assert.equal(JSON.parse(exported).events[0].sandboxId, "owned", "non-secret metadata remains reviewable");
      run.controller.abort();
      assert.equal((await reconnect("owned")).status, 409, "cancel immediately revokes reconnect access");
      run.finish("cancelled");
      assert.equal((await reconnect("owned")).status, 409);
    } finally {
      if (previous) live.set("daytona", previous); else live.delete("daytona");
    }
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

// ---------------------------------------------------------------- OpenAI agent loop

function response(output: unknown[], extra: Record<string, unknown> = {}): Response {
  return {
    id: "resp", object: "response", model: "gpt-6.1-sol", status: "completed", output, output_text: "", error: null, incomplete_details: null,
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1100 },
    ...extra,
  } as unknown as Response;
}
const say = (text: string) => ({ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const fn = (callId: string, name: string, args: unknown) => ({ type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" });

function fakeOpenAI(responses: Response[]) {
  const requests: Record<string, unknown>[] = [];
  const client: OpenAIAgentClient = {
    responses: { create: async body => {
      requests.push(structuredClone(body) as unknown as Record<string, unknown>);
      const next = responses.shift();
      if (!next) throw new Error("no more scripted responses");
      return next;
    } },
  };
  return { client, requests };
}

const openaiLoop = (client: OpenAIAgentClient, tools: ToolExecutor, model = "gpt-6.1-sol", maxTurns = 25) => runOpenAIAgentLoop({
  client, model, effort: "high", prompt: "do it", system: "sys", tools, maxTurns, timeLimitMs: 60_000, signal: new AbortController().signal,
});

test("the OpenAI loop runs parallel function calls and answers each by call_id, statelessly", async () => {
  const reasoning = { type: "reasoning", id: "rs", summary: [], encrypted_content: "opaque" };
  const { client, requests } = fakeOpenAI([
    response([reasoning, say("Working on it"),
      fn("c1", "run_command", { command: "echo hi", cwd: null, timeout: null }),
      fn("c2", "write_file", { path: "relative.txt", content: "x" }),
      fn("c3", "write_file", { path: "/tmp/a.txt", content: "x" })]),
    response([say("Done.")]),
  ]);
  const { tools, calls } = recordingTools();
  const result = await openaiLoop(client, tools);

  assert.equal(result.stop, "end_turn");
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.finalText, "Done.");
  assert.deepEqual(calls.sort(), ["run:echo hi", "write:/tmp/a.txt"], "nulls are dropped and invalid input never reaches the sandbox");

  const first = requests[0]!;
  assert.equal(first.model, "gpt-6.1-sol");
  assert.equal(first.instructions, "sys");
  assert.equal(first.store, false);
  assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(first.reasoning, { effort: "high" });
  assert.equal(first.parallel_tool_calls, true);
  for (const tool of first.tools as { type: string; strict: boolean; parameters: { required: string[]; properties: object; additionalProperties: boolean } }[]) {
    assert.equal(tool.type, "function");
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties), "strict mode lists every property");
  }
  assert.deepEqual((OPENAI_TOOLS[0]!.parameters as { properties: { cwd: { type: unknown } } }).properties.cwd.type, ["string", "null"]);

  const input = requests[1]!.input as { type?: string; role?: string; call_id?: string; output?: string }[];
  assert.deepEqual(input.map(item => item.type ?? item.role), ["user", "reasoning", "message", "function_call", "function_call", "function_call", "function_call_output", "function_call_output", "function_call_output"]);
  const outputs = input.filter(item => item.type === "function_call_output");
  assert.deepEqual(outputs.map(item => item.call_id), ["c1", "c2", "c3"]);
  assert.match(outputs[1]!.output!, /^Error: Invalid input/);

  // input_tokens includes cached reads and cache writes: 500 uncached per response. No price for gpt-6.1-sol.
  assert.deepEqual({ ...result.usage, costUsd: 0 }, { input: 1000, output: 200, cacheRead: 800, cacheWrite: 200, costUsd: 0 });
  assert.ok(Number.isNaN(result.usage.costUsd), "an unpriced model has no cost");
});

test("the OpenAI loop prices gpt-6-luna, never runs tools from a refusal or a cut-off response, and stops at the turn limit", async () => {
  const call = fn("c1", "run_command", { command: "rm -rf /tmp/x", cwd: null, timeout: null });
  const priced = fakeOpenAI([response([say("ok")], { model: "gpt-6-luna" })]);
  const usage = (await openaiLoop(priced.client, recordingTools().tools, "gpt-6-luna")).usage;
  // 500 input at $0.10, 100 output at $0.50, 400 cached at $0.01, 100 written at $0.125 per MTok.
  assert.equal(Math.round(usage.costUsd * 1e9) / 1e9, 0.0001165);

  const refusal = { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] };
  for (const [output, extra, stop] of [
    [[refusal, call], {}, "refusal"],
    [[call], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "max_tokens"],
    [[call], { status: "incomplete", incomplete_details: { reason: "content_filter" } }, "refusal"],
  ] as const) {
    const { client } = fakeOpenAI([response([...output], extra)]);
    const { tools, calls } = recordingTools();
    assert.equal((await openaiLoop(client, tools)).stop, stop);
    assert.deepEqual(calls, []);
  }
  const { client } = fakeOpenAI([response([call]), response([call])]);
  assert.equal((await openaiLoop(client, recordingTools().tools, "gpt-6.1-sol", 2)).stop, "max_turns");
});

test("the agent test runs an OpenAI model in a sandbox, streams each step, and the verify command judges it", async () => {
  const { client, requests } = fakeOpenAI([response([fn("c1", "run_command", { command: "git init /tmp/repo", cwd: null, timeout: null })]), response([say("Done.")])]);
  setOpenAIClientFactory(() => client);
  const { provider, sandboxes } = fakeProvider("fake");
  const events: Record<string, unknown>[] = [];
  const result = await agent({
    runId: "r1", module: "fake", title: "Fake", provider, options: { model: "gpt-6.1-sol", tasks: ["git"], maxTurns: 5 },
    signal: new AbortController().signal, emit: event => events.push(event), env: {},
  }) as { backend: string; tasks: Record<string, { passed: boolean; costUsd: number | null; toolCalls: number }> };

  assert.equal(requests.length, 2);
  assert.equal(result.backend, "openai");
  assert.deepEqual({ ...result.tasks.git }, { ...result.tasks.git, passed: true, costUsd: null, toolCalls: 1 });
  const kinds = events.filter(event => event.type === "agent").map(event => event.kind);
  assert.deepEqual(kinds, ["task_start", "sandbox", "sandbox", "turn", "tool_call", "tool_result", "turn", "text", "stop", "verify_start", "verify", "sandbox", "task_done"]);
  const call = events.find(event => event.kind === "tool_call")!, output = events.find(event => event.kind === "tool_result")!;
  assert.equal(call.command, "git init /tmp/repo");
  assert.deepEqual([output.exitCode, output.stdout, output.stderr], [0, "ok\n", ""], "the terminal gets the raw exit code and output");
  assert.equal(sandboxes.size, 0, "the task's sandbox is destroyed");
});

test("the agent test writes a task's files and runs its setup before the agent, shown in the terminal", async () => {
  const { client } = fakeOpenAI([response([say("Done.")])]);
  setOpenAIClientFactory(() => client);
  const { provider } = fakeProvider("fake");
  const written: string[] = [], commands: string[] = [];
  const traced = { ...provider, writeFile: async (id: string, path: string, data: Uint8Array | string) => { written.push(path); return provider.writeFile(id, path, data); },
    exec: async (id: string, command: string, options?: object) => { commands.push(command); return provider.exec(id, command, options); } } as typeof provider;
  const events: Record<string, unknown>[] = [];
  await agent({ runId: "r2", module: "fake", title: "Fake", provider: traced, options: { model: "gpt-6.1-sol", tasks: ["browser"] }, signal: new AbortController().signal, emit: event => events.push(event), env: {} });
  assert.deepEqual(written.slice(0, 2), ["/tmp/osb-site/index.html", "/tmp/open-sb-playground/setup-browser-1.sh"], "the page, then the server script (no background capability: nohup)");
  assert.match(commands.find(command => command.startsWith("nohup"))!, /^nohup sh \/tmp\/open-sb-playground\/setup-browser-1\.sh/);
  const kinds = events.filter(event => event.type === "agent").map(event => event.kind);
  assert.deepEqual(kinds.slice(0, 9), ["task_start", "sandbox", "sandbox", "setup", "setup_done", "setup", "setup_done", "setup", "setup_done"]);
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
  assert.deepEqual(validateValues("openai", { OPENAI_API_KEY: "sk-proj-fake" }), { OPENAI_API_KEY: "sk-proj-fake" });
  assert.throws(() => validateValues("openai", { ANTHROPIC_API_KEY: "x" }), CredentialError, "Claude's variable is not OpenAI's");
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
      assert.equal(field("openai", "OPENAI_API_KEY"), "unset");

      const providers = JSON.parse((await get(port, "/api/providers")).body) as { providers: { module: string; available: boolean }[] };
      assert.equal(providers.providers.find(entry => entry.module === "e2b")!.available, true, "a saved key makes the provider available without a restart");

      // A key saved after the server started is redacted too.
      saveValues("claude", { ANTHROPIC_API_KEY: "sk-ant-later-dddddddd" });
      saveValues("openai", { OPENAI_API_KEY: "sk-proj-later-eeeeeeee" });
      assert.equal(app.redact("a sk-ant-later-dddddddd b saved_value_cccccccc c sk-proj-later-eeeeeeee"), "a [redacted] b [redacted] c [redacted]");
      assert.ok(secretValues({ OPENAI_API_KEY: "sk-proj-env-ffffffff" }).includes("sk-proj-env-ffffffff"), "an OpenAI key from the environment is redacted too");
      const deleted = await request(port, "DELETE", "/api/credentials/e2b");
      assert.equal(deleted.status, 200);
      assert.equal(loadSaved().e2b, undefined);
    }, env);
  });
});
