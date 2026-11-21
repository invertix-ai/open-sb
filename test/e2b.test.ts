// E2B label filtering, exit codes and error mapping, through a substituted SDK Sandbox class (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthenticationError, CommandExitError, RateLimitError, SandboxNotFoundError, SandboxNotRunningError, ServiceBusyError,
  TimeoutError, type Sandbox,
} from "e2b";
import { SandboxError } from "../src/errors.ts";
import { e2b } from "../src/providers/e2b.ts";

const sandboxInfo = (sandboxId: string, metadata: Record<string, string>, state = "running") =>
  ({ sandboxId, metadata, state, startedAt: new Date(0), endAt: new Date(60_000) });

function fake() {
  const calls: { method: string; args: unknown[] }[] = [];
  let runs: ((command: string) => Promise<unknown>)[] = [];
  const connection = (sandboxId: string) => ({
    sandboxId,
    commands: { run: (command: string, opts: unknown) => { calls.push({ method: "run", args: [command, opts] }); return (runs.shift() ?? (async () => ({ exitCode: 0, stdout: command, stderr: "" })))(command); } },
  });
  const Fake = {
    async create(opts: unknown) { calls.push({ method: "create", args: [opts] }); return connection("new"); },
    async connect(id: string) { calls.push({ method: "connect", args: [id] }); return connection(id); },
    async getInfo(id: string) { if (id === "gone") throw new SandboxNotFoundError("404: body with secret"); return sandboxInfo(id, {}, "paused"); },
    async kill() { throw new AuthenticationError("Unauthorized - body with secret"); },
    async pause(id: string) { throw id === "busy" ? new ServiceBusyError("busy - body") : new RateLimitError("Rate limit - body"); },
    list(opts: unknown) {
      calls.push({ method: "list", args: [opts] });
      // Two pages, and a server that ignores the metadata filter: the provider must still filter exactly.
      const pages = [[sandboxInfo("a", { team: "x" }), sandboxInfo("b", { team: "y" })], [sandboxInfo("c", { team: "x", other: "1" }, "paused")]];
      return { get hasNext() { return pages.length > 0; }, async nextItems() { return pages.shift()!; } };
    },
  };
  return { calls, Sandbox: Fake as unknown as typeof Sandbox, setRuns: (next: typeof runs) => { runs = next; } };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("body"), "provider bodies must not reach the message");
  return true;
};

test("e2b filters labels exactly across pages", async () => {
  const { calls, Sandbox } = fake();
  const provider = e2b({ apiKey: "key", Sandbox });
  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state]), [["a", "running"], ["c", "stopped"]]);
  assert.deepEqual((calls[0]!.args[0] as { query: unknown }).query, { metadata: { team: "x" } });
  assert.equal((await provider.list()).length, 3);
});

test("e2b reports exit codes, reconnects stale sandboxes and maps errors", async () => {
  const { calls, Sandbox, setRuns } = fake();
  const provider = e2b({ apiKey: "key", Sandbox });

  setRuns([async () => { throw new CommandExitError({ exitCode: 3, stdout: "out", stderr: "err" }); }]);
  assert.deepEqual(await provider.exec("s1", "exit 3"), { exitCode: 3, stdout: "out", stderr: "err" });
  const run = calls.find(call => call.method === "run")!;
  assert.deepEqual((run.args[1] as { envs: unknown }).envs, undefined);
  await provider.exec("s1", "true", { env: { A: "it's" }, cwd: "/tmp" });
  assert.equal(calls.filter(call => call.method === "connect").length, 1, "the connection is reused");
  assert.deepEqual(calls.at(-1)!.args[1], { cwd: "/tmp", envs: { A: "it's" }, signal: undefined, timeoutMs: 300_000 });

  // A sandbox paused elsewhere: reconnect once (which resumes it) and run again.
  setRuns([async () => { throw new SandboxNotRunningError("paused"); }]);
  assert.equal((await provider.exec("s1", "echo hi")).stdout, "echo hi");
  assert.equal(calls.filter(call => call.method === "connect").length, 2);

  setRuns([async () => { throw new TimeoutError("deadline_exceeded: body"); }]);
  await assert.rejects(provider.exec("s1", "sleep 999", { timeoutMs: 10 }), kind("timeout"));

  assert.equal(await provider.get("gone"), null);
  assert.equal((await provider.get("p"))?.state, "stopped");
  assert.equal((await provider.get("p"))?.expiresAt, undefined);
  await assert.rejects(provider.pause("s1"), kind("unavailable", 429));
  await assert.rejects(provider.pause("busy"), kind("unavailable", 503));
  await assert.rejects(provider.destroy("s1"), kind("rejected", 401));

  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(provider.pause("s1", { signal: aborted }), /stop/);
});

test("e2b passes idempotency keys in the form E2B accepts", async () => {
  const { calls, Sandbox } = fake();
  const provider = e2b({ apiKey: "key", Sandbox });
  await provider.create({ idempotencyKey: "0d5c-ok", labels: { a: "b" } });
  await provider.create({ idempotencyKey: "Not Valid!" });
  const keys = calls.filter(call => call.method === "create").map(call => (call.args[0] as { idempotencyKey: string }).idempotencyKey);
  assert.equal(keys[0], "0d5c-ok");
  assert.match(keys[1]!, /^[a-f0-9]{64}$/);
  assert.deepEqual((calls[0]!.args[0] as { metadata: unknown }).metadata, { a: "b" });
});
