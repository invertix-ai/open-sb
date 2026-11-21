// Runloop labels, states, exec results and error mapping, through a substituted client (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { APIConnectionError, APIError } from "@runloop/api-client";
import type { DevboxAsyncExecutionDetailView, DevboxView } from "@runloop/api-client/resources/devboxes/devboxes";
import { SandboxError } from "../src/errors.ts";
import { runloop, type RunloopClient } from "../src/providers/runloop.ts";

const status = (code: number, headers: Record<string, string> = {}) =>
  APIError.generate(code, { message: "secret detail" }, "secret detail", headers);

test("runloop maps labels, states, exec results and failures", async () => {
  const devboxes = new Map<string, DevboxView>();
  const commands: string[] = [];
  const waits: string[] = [];
  const add = (id: string, state: DevboxView["status"], metadata: Record<string, string>) =>
    devboxes.set(id, { id, status: state, metadata, create_time_ms: Date.parse("2026-11-20T10:00:00Z") } as DevboxView);
  add("a", "running", { team: "a", extra: "1" });
  add("b", "suspended", { team: "a" });
  add("c", "provisioning", { team: "b" });
  add("d", "shutdown", { team: "a" });
  const done = (command: string): DevboxAsyncExecutionDetailView => command.includes("exit 3")
    ? { devbox_id: "a", execution_id: "x", status: "completed", exit_status: 3, stdout: "", stderr: "" }
    : command.includes("long-output")
      ? { devbox_id: "a", execution_id: "long", status: "completed", exit_status: 0, stdout: "tail", stdout_truncated: true, stderr: "" }
      : { devbox_id: "a", execution_id: "x", status: "completed", exit_status: 0, stdout: "hello\n", stderr: "oops\n" };
  const retrieve = async (id: string) => {
    if (id === "busy") throw status(503);
    if (id === "limited") throw status(429, { "retry-after": "7" });
    if (id === "offline") throw new APIConnectionError({ message: "secret detail" });
    const devbox = devboxes.get(id);
    if (!devbox) throw status(404);
    return devbox;
  };
  const client = {
    baseURL: "https://api.runloop.ai",
    devboxes: {
      async create(body) {
        const id = `new-${devboxes.size}`;
        add(id, "provisioning", body.metadata ?? {});
        return devboxes.get(id)!;
      },
      retrieve,
      // Pages through everything on purpose: the provider must filter labels exactly on its own.
      async *list() { yield* devboxes.values(); },
      async shutdown(id) { const devbox = await retrieve(id); devbox.status = "shutdown"; return devbox; },
      async suspend(id) { const devbox = await retrieve(id); devbox.status = "suspended"; return devbox; },
      async resume(id) { const devbox = await retrieve(id); devbox.status = "running"; return devbox; },
      async execute(id, params) {
        await retrieve(id);
        commands.push(params.command);
        return params.command.includes("slow")
          ? { devbox_id: id, execution_id: "slow", status: "running" } : done(params.command);
      },
      async waitForCommand(_id, executionId) {
        waits.push(executionId);
        // The first wait runs out on Runloop's side (408); the second sees the command finish.
        if (waits.length === 1) throw status(408);
        return { devbox_id: "a", execution_id: executionId, status: "completed", exit_status: 0, stdout: "late\n", stderr: "" };
      },
      async executeAsync(id) { return { devbox_id: id, execution_id: "bg", status: "running" }; },
      async downloadFile() { return new Response(new Uint8Array([0, 1, 255])); },
      async uploadFile() { return {}; },
      async enableTunnel() {
        return { auth_mode: "authenticated", auth_token: "tunnel-token", tunnel_key: "k3y", create_time_ms: 0, http_keep_alive: true, wake_on_http: false };
      },
      async snapshotDiskAsync(id, body) { return { id: "snp-1", name: body.name, create_time_ms: 0, metadata: {}, source_devbox_id: id }; },
      async *listDiskSnapshots() {
        yield { id: "snp-0", name: "mine", create_time_ms: 1, metadata: {}, source_devbox_id: "a" };
        yield { id: "snp-s", name: null, create_time_ms: 2, metadata: {}, source_devbox_id: "a" };
      },
      async deleteDiskSnapshot(id) { if (id === "snp-0") throw status(404); return {}; },
      diskSnapshots: { async queryStatus() { return { status: "complete" as const }; } },
      executions: {
        async kill() { return {}; },
        async streamStdoutUpdates() { return (async function* () { yield { output: "head " }; yield { output: "tail" }; })(); },
        async streamStderrUpdates() { return (async function* () {})(); },
      },
    },
  } satisfies RunloopClient;
  const provider = runloop({ client });

  const listed = await provider.list({ labels: { team: "a" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state]), [["a", "running"], ["b", "stopped"], ["d", "gone"]]);
  assert.equal((await provider.get("c"))?.state, "starting");
  assert.equal((await provider.get("a"))?.createdAt?.toISOString(), "2026-11-20T10:00:00.000Z");

  assert.equal(await provider.get("missing"), null);
  await assert.rejects(provider.get("busy"), (error: unknown) => error instanceof SandboxError && error.kind === "unavailable" && error.status === 503);
  await assert.rejects(provider.get("limited"), (error: unknown) => error instanceof SandboxError && error.kind === "unavailable" && error.retryAfter === 7);
  await assert.rejects(provider.get("offline"), (error: unknown) => error instanceof SandboxError && error.kind === "unavailable" && error.code === "network");
  await assert.rejects(provider.exec("missing", "true"), (error: unknown) =>
    error instanceof SandboxError && error.kind === "not_found" && !error.message.includes("secret detail"));

  const hello = await provider.exec("a", "echo hello; echo oops >&2", { cwd: "/tmp/it's", env: { GREETING: "it's ok" } });
  assert.deepEqual(hello, { exitCode: 0, stdout: "hello\n", stderr: "oops\n" });
  assert.equal(commands.at(-1), `sh -c 'export GREETING='\\''it'\\''\\'\\'''\\''s ok'\\'' && cd '\\''/tmp/it'\\''\\'\\'''\\''s'\\'' && echo hello; echo oops >&2'`);
  assert.equal((await provider.exec("a", "exit 3")).exitCode, 3, "a nonzero exit is a result, not an error");
  assert.equal((await provider.exec("a", "slow")).stdout, "late\n", "a 408 while waiting means still running");
  assert.equal((await provider.exec("a", "long-output")).stdout, "head tail", "truncated output is read from the stream");

  const first = await provider.create({ labels: { team: "z" }, idempotencyKey: "key-1" });
  const again = await provider.create({ labels: { team: "z" }, idempotencyKey: "key-1" });
  assert.equal(again.id, first.id, "the same idempotency key returns the same sandbox");
  assert.deepEqual(first.labels, { team: "z" }, "the idempotency label stays internal");

  assert.deepEqual(await provider.readFile("a", "/tmp/x"), new Uint8Array([0, 1, 255]));
  assert.deepEqual(await provider.portUrl("a", 8080),
    { url: "https://8080-k3y.tunnel.runloop.ai", headers: { "X-Runloop-Tunnel-Authorization": "Bearer tunnel-token" } });
  assert.deepEqual(await provider.listSnapshots(), ["mine"]);
  await assert.rejects(provider.snapshot("a", "mine"), (error: unknown) => error instanceof SandboxError && error.code === "snapshot_exists");
  await provider.snapshot("a", "fresh");
  await provider.deleteSnapshot("mine");

  await provider.pause("a");
  assert.equal((await provider.get("a"))?.state, "stopped");
  await provider.resume("a");
  await provider.destroy("a");
  await provider.destroy("a");
  await provider.destroy("never-existed");
  assert.equal((await provider.get("a"))?.state, "gone");

  const controller = new AbortController();
  controller.abort(new Error("caller gave up"));
  await assert.rejects(provider.get("a", { signal: controller.signal }), /caller gave up/);
});
