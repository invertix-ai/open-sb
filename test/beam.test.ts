// Beam label filtering, exit codes, idempotency and error mapping, through a substituted SDK VM class (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxFileSystemError, VMError, type VM } from "@beamcloud/beam-js";
import { SandboxError } from "../src/errors.ts";
import { beam } from "../src/providers/beam.ts";

const info = (id: string, metadata: Record<string, string>, status = "running") => ({
  id, metadata, status, createdAt: "2026-01-01T00:00:00Z", lastActiveAt: new Date().toISOString(), spec: { idleTimeout: 900 },
});
/** A failure as the SDK raises it after an HTTP answer, with a body that must not reach our message. */
const http = (status: number) => new VMError("body with secret", status);

function fake() {
  const calls: { method: string; args: unknown[] }[] = [];
  const files = new Map<string, Uint8Array>();
  let waits: (() => Promise<number>)[] = [];
  const vm = (data: ReturnType<typeof info>) => ({
    info: data, id: data.id, status: data.status,
    execShell: async (command: string, opts: unknown) => {
      calls.push({ method: "execShell", args: [command, opts] });
      return {
        wait: waits.shift() ?? (async () => 0),
        kill: async () => { calls.push({ method: "kill", args: [] }); },
        stdout: { read: async () => command }, stderr: { read: async () => "" },
      };
    },
    exec: async (argv: string[]) => { calls.push({ method: "exec", args: argv }); return { wait: async () => 0 }; },
    fs: {
      readBytes: async (path: string) => { const data = files.get(path); if (!data) throw new SandboxFileSystemError("open: no such file: secret"); return Buffer.from(data); },
      writeBytes: async (path: string, data: Uint8Array | string) => {
        // Beam needs the parent directory to exist.
        if (!calls.some(call => call.method === "exec")) throw new SandboxFileSystemError("parent missing");
        files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
    },
    pause: async () => { throw data.id === "busy" ? http(503) : new VMError("network down", undefined, { isAxiosError: true, code: "ECONNRESET" }); },
    remove: async () => { calls.push({ method: "remove", args: [data.id] }); },
  });
  const Fake = {
    async get(id: string) {
      calls.push({ method: "get", args: [id] });
      if (id === "gone") throw http(404);
      if (id === "denied") throw http(401);
      return vm(info(id, {}, id === "paused" ? "paused" : "running"));
    },
    async list(opts: unknown) {
      calls.push({ method: "list", args: [opts] });
      // A server that ignores the metadata filter: the provider must still filter exactly, and drop deleted VMs.
      return [vm(info("a", { team: "x" })), vm(info("b", { team: "y" })), vm(info("c", { team: "x", other: "1" }, "paused")),
        vm(info("d", { team: "x" }, "deleted"))];
    },
    async create(config: { metadata: Record<string, string> }) {
      calls.push({ method: "create", args: [config] });
      return vm(info("new", config.metadata));
    },
    snapshots: { list: async () => [{ id: "snap-1", name: "saved", delete: async () => {} }] },
  };
  const FakeImage = { fromRegistry: (tag: string) => ({ tag }) };
  return {
    calls, VM: Fake as unknown as typeof VM, Image: FakeImage as never,
    setWaits: (next: typeof waits) => { waits = next; },
  };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("secret"), "provider bodies must not reach the message");
  return true;
};

test("beam filters labels exactly and maps states", async () => {
  const { calls, VM, Image } = fake();
  const provider = beam({ token: "key", VM, Image });
  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state]), [["a", "running"], ["c", "stopped"]]);
  assert.deepEqual(calls[0]!.args[0], { all: true, metadata: { team: "x" } });
  assert.equal((await provider.list()).length, 3);
  assert.equal(await provider.get("gone"), null);
  assert.equal((await provider.get("paused"))?.state, "stopped");
  assert.equal((await provider.get("paused"))?.expiresAt, undefined);
  assert.ok((await provider.get("a"))?.expiresAt, "a running VM reports when its idle timeout ends");
});

test("beam reports exit codes, timeouts and files", async () => {
  const { calls, VM, Image, setWaits } = fake();
  const provider = beam({ token: "key", VM, Image });

  setWaits([async () => 3]);
  assert.deepEqual(await provider.exec("s1", "exit 3"), { exitCode: 3, stdout: "exit 3", stderr: "" });
  await provider.exec("s1", "true", { env: { A: "it's" }, cwd: "/tmp" });
  assert.deepEqual(calls.at(-1)!.args, ["true", { env: { A: "it's" }, wait: true, cwd: "/tmp" }]);
  assert.equal(calls.filter(call => call.method === "get").length, 1, "the VM is resolved once");

  setWaits([async () => { throw new VMError("Process 7 did not exit before timeout"); }]);
  await assert.rejects(provider.exec("s1", "sleep 999", { timeoutMs: 10 }), kind("timeout"));
  assert.equal(calls.at(-1)!.method, "kill", "a timed-out command is killed");

  const bytes = new Uint8Array(256).map((_, index) => index);
  await provider.writeFile("s1", "/tmp/open-sb/binary.bin", bytes);
  assert.deepEqual(calls.find(call => call.method === "exec")!.args, ["mkdir", "-p", "--", "/tmp/open-sb"]);
  assert.deepEqual(await provider.readFile("s1", "/tmp/open-sb/binary.bin"), bytes);
  await assert.rejects(provider.readFile("s1", "/missing"), kind("not_found"));
});

test("beam maps errors and passes idempotency keys as UUIDs", async () => {
  const { calls, VM, Image } = fake();
  const provider = beam({ token: "key", VM, Image });
  await assert.rejects(provider.pause("busy"), kind("unavailable", 503));
  await assert.rejects(provider.pause("s1"), kind("unavailable"));
  await assert.rejects(provider.get("denied"), kind("rejected", 401));
  await provider.destroy("gone");
  await provider.destroy("s1");
  assert.ok(calls.some(call => call.method === "remove"));
  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(provider.pause("s1", { signal: aborted }), /stop/);

  await provider.create({ idempotencyKey: "Not A UUID!", labels: { a: "b" }, image: "saved" });
  await provider.create({ idempotencyKey: "0D5C1E2A-0000-4000-8000-000000000000", image: "ubuntu:24.04" });
  const [first, second] = calls.filter(call => call.method === "create").map(call => call.args[0] as Record<string, unknown>);
  assert.match(first!.requestId as string, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(first!.metadata, { a: "b" });
  assert.equal(first!.snapshot, "snap-1", "a snapshot name starts from that snapshot");
  assert.equal(second!.requestId, "0d5c1e2a-0000-4000-8000-000000000000");
  assert.deepEqual(second!.image, { tag: "ubuntu:24.04" });
  assert.equal(second!.ssh, false);
});
