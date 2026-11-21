// Freestyle label filtering, exit codes, idempotency and error mapping, through a substituted SDK client (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { FreestyleApiError, FreestyleTransportError } from "freestyle";
import { SandboxError } from "../src/errors.ts";
import { freestyle, type FreestyleClientLike } from "../src/providers/freestyle.ts";

const vmData = (id: string, metadata: Record<string, string>, state = "running", extra: object = {}) =>
  ({ id, metadata, state, createdAt: new Date(0).toISOString(), ...extra });
const apiError = (status: number, code: string) => new FreestyleApiError(status, { code, message: "body with secret" });

function fake() {
  const calls: { method: string; args: unknown[] }[] = [];
  let execs: (() => Promise<unknown>)[] = [];
  const vms: Record<string, ReturnType<typeof vmData>> = { known: vmData("vm-known", {}, "paused", { ttlSeconds: 120 }) };
  const ref = (id: string) => ({
    async exec(opts: unknown) { calls.push({ method: "exec", args: [id, opts] }); return (execs.shift() ?? (async () => ({ statusCode: 0, stdout: "ok", stderr: null })))(); },
    async pause() { throw id === "busy" ? apiError(503, "UNAVAILABLE") : apiError(429, "RATE_LIMITED"); },
    async update(opts: unknown) { calls.push({ method: "update", args: [id, opts] }); return vms[id]; },
    fs: { async readFile() { throw new FreestyleTransportError(new Error("fetch failed"), [{ code: "ECONNRESET" }]); } },
  });
  const client = {
    vms: {
      ref,
      async get(id: string) { if (!vms[id]) throw apiError(404, "VM_NOT_FOUND"); return vms[id]; },
      async create(opts: { slug?: string; metadata: Record<string, string> }) {
        calls.push({ method: "create", args: [opts] });
        const data = vmData("vm-new", opts.metadata);
        if (opts.slug) vms[opts.slug] = data;
        return { vm: ref("vm-new"), vmId: "vm-new", data };
      },
      async delete(id: string) { if (id === "gone") throw apiError(404, "VM_NOT_FOUND"); throw apiError(401, "UNAUTHORIZED"); },
      async list(opts: { offset: number; metadata?: string }) {
        calls.push({ method: "list", args: [opts] });
        // A server that ignores the metadata filter, over two pages: the provider must still filter exactly.
        const all = [...Array.from({ length: 100 }, (_, index) => vmData(`vm-${index}`, { team: index === 7 ? "x" : "y" })),
          vmData("vm-last", { team: "x", other: "1" }, "pausing")];
        return { vms: all.slice(opts.offset, opts.offset + 100), totalCount: all.length };
      },
    },
  };
  return { calls, client: client as unknown as FreestyleClientLike, setExecs: (next: typeof execs) => { execs = next; } };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("body"), "provider bodies must not reach the message");
  return true;
};

test("freestyle filters labels exactly across pages", async () => {
  const { calls, client } = fake();
  const provider = freestyle({ client });
  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state]), [["vm-7", "running"], ["vm-last", "stopped"]]);
  assert.equal((calls[0]!.args[0] as { metadata: string }).metadata, "team:x");
  assert.equal(calls.filter(call => call.method === "list").length, 2);
  // Separators in a label cannot be sent to the API; the provider filters on its own.
  await provider.list({ labels: { team: "a,b" } });
  assert.equal((calls.at(-1)!.args[0] as { metadata?: string }).metadata, undefined);
});

test("freestyle reports exit codes, cwd and env, and maps errors", async () => {
  const { calls, client, setExecs } = fake();
  const provider = freestyle({ client });

  setExecs([async () => ({ statusCode: 3, stdout: "out", stderr: "err" })]);
  assert.deepEqual(await provider.exec("vm-1", "exit 3"), { exitCode: 3, stdout: "out", stderr: "err" });
  assert.deepEqual(await provider.exec("vm-1", "pwd", { cwd: "/tmp/it's", env: { A: "it's" } }), { exitCode: 0, stdout: "ok", stderr: "" });
  assert.deepEqual(calls.at(-1)!.args[1], { command: "cd -- '/tmp/it'\\''s' && {\npwd\n}", env: { A: "it's" }, timeoutMs: 300_000 });
  setExecs([async () => ({ statusCode: null, stdout: "", stderr: "" })]);
  await assert.rejects(provider.exec("vm-1", "sleep 999"), kind("timeout"));
  setExecs([async () => { throw apiError(502, "BAD_GATEWAY"); }]);
  await assert.rejects(provider.exec("vm-1", "true"), kind("unavailable", 502));

  assert.equal(await provider.get("gone"), null);
  const known = await provider.get("known");
  assert.equal(known?.state, "stopped");
  assert.equal(known?.expiresAt?.getTime(), 120_000);
  await provider.destroy("gone"); // already deleted: not an error
  await assert.rejects(provider.destroy("vm-1"), kind("rejected", 401));
  await assert.rejects(provider.readFile("vm-1", "/x"), kind("unavailable"));

  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(provider.exec("vm-1", "true", { signal: aborted }), /stop/);
});

test("freestyle pauses, sets ttl from creation and reuses idempotent creates", async () => {
  const { calls, client } = fake();
  const provider = freestyle({ client });
  await provider.pause("known"); // already paused: no call
  await assert.rejects(provider.pause("missing"), kind("not_found"));

  await provider.setTtl("known", 1_800);
  const ttl = (calls.at(-1)!.args[1] as { ttlSeconds: number }).ttlSeconds;
  assert.ok(Math.abs(ttl - (Math.ceil(Date.now() / 1000) + 1_800)) <= 2, "the deadline counts from creation");

  const first = await provider.create({ idempotencyKey: "Retry Me!", labels: { a: "b" } });
  const again = await provider.create({ idempotencyKey: "Retry Me!", labels: { a: "b" } });
  assert.equal(again.id, first.id);
  const creates = calls.filter(call => call.method === "create");
  assert.equal(creates.length, 1);
  assert.match((creates[0]!.args[0] as { slug: string }).slug, /^osb-[a-f0-9]{32}$/);
  assert.deepEqual((creates[0]!.args[0] as { metadata: unknown }).metadata, { a: "b" });
});
