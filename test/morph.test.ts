// Morph labels, exit codes, files, snapshot names and error mapping, through a substituted client (no account
// needed). The fake runs exec scripts with the local `sh`, so quoting and the base64 file transfer are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SandboxError } from "../src/errors.ts";
import { morph, type MorphClient, type MorphInstance, type MorphSnapshot } from "../src/providers/morph.ts";

const scratch = mkdtempSync(join(tmpdir(), "open-sb-morph-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The SDK's error shape: a plain Error whose message carries the status and the response body. */
const http = (status: number) => new Error(`HTTP ${status} Error for https://cloud.morph.so/api/x\nResponse Body: {"secret":"body"}`);

function fake() {
  const calls: { method: string; args: unknown[] }[] = [];
  const instances = new Map<string, MorphInstance>();
  const snapshots: MorphSnapshot[] = [];
  let failNext: Error | undefined;
  const snapshot = (id: string, metadata: Record<string, string>, created: number): MorphSnapshot => {
    const item: MorphSnapshot = { id, status: "ready", created, metadata,
      async delete() { snapshots.splice(snapshots.indexOf(item), 1); } };
    snapshots.push(item);
    return item;
  };
  const instance = (id: string, status: string, metadata: Record<string, string>): MorphInstance => {
    const item: MorphInstance = {
      id, status, created: 1_790_000_000, metadata, ttl: {}, networking: { httpServices: [] },
      async pause() { item.status = "paused"; },
      async resume() { item.status = "ready"; },
      async exec(command) {
        calls.push({ method: "exec", args: [command] });
        if (failNext) { const error = failNext; failNext = undefined; throw error; }
        const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
        return { exit_code: result.status ?? 128, stdout: result.stdout, stderr: result.stderr };
      },
      async snapshot(options) { return snapshot(`snapshot_${snapshots.length}`, options?.metadata ?? {}, Date.now()); },
      async exposeHttpService(name, port) {
        const service = { name, port, url: `https://${name}-${id}.http.cloud.morph.so` };
        item.networking!.httpServices!.push(service);
        return service;
      },
      async setTTL(seconds) { item.ttl = { ttlExpireAt: Math.floor(Date.now() / 1000) + seconds }; },
    };
    instances.set(id, item);
    return item;
  };
  instance("a", "ready", { team: "x" });
  instance("b", "paused", { team: "y" });
  instance("c", "pending", { team: "x", other: "1" });
  const client: MorphClient = {
    snapshots: {
      async list(options = {}) {
        calls.push({ method: "snapshots.list", args: [options] });
        return snapshots.filter(item => !options.digest || item.id === `base-${options.digest}`);
      },
      async create(options = {}) { calls.push({ method: "snapshots.create", args: [options] }); return snapshot(`base-${options.digest}`, options.metadata ?? {}, 1); },
      async get({ snapshotId }) { return snapshots.find(item => item.id === snapshotId)!; },
    },
    instances: {
      // A server that ignores the metadata filter: the provider must still filter exactly.
      async list(options = {}) { calls.push({ method: "instances.list", args: [options] }); return [...instances.values()]; },
      async start(options) {
        calls.push({ method: "start", args: [options] });
        if (failNext) { const error = failNext; failNext = undefined; throw error; }
        return instance(`new-${instances.size}`, "ready", options.metadata ?? {});
      },
      async get({ instanceId }) {
        const found = instances.get(instanceId);
        if (!found) throw http(404);
        return found;
      },
      async stop({ instanceId }) { if (!instances.delete(instanceId)) throw http(404); },
    },
  };
  return { calls, client, instances, failWith: (error: Error) => { failNext = error; } };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("body"), "provider bodies must not reach the message");
  return true;
};

test("morph filters labels exactly and maps states", async () => {
  const { calls, client } = fake();
  const provider = morph({ client });
  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state]), [["a", "running"], ["c", "starting"]]);
  assert.deepEqual(calls.find(call => call.method === "instances.list")!.args[0], { metadata: { team: "x" } });
  assert.equal((await provider.list()).length, 3);
  assert.equal((await provider.get("b"))?.state, "stopped");
  assert.equal(await provider.get("missing"), null);
});

test("morph reports exit codes, keeps quotes in env and round-trips binary files", async () => {
  const { client } = fake();
  const provider = morph({ client });
  assert.deepEqual(await provider.exec("a", "echo hello; echo oops >&2"), { exitCode: 0, stdout: "hello\n", stderr: "oops\n" });
  assert.equal((await provider.exec("a", "exit 3")).exitCode, 3);
  assert.equal((await provider.exec("a", 'printf %s "$GREETING"', { env: { GREETING: "it's \"ok\"" } })).stdout, "it's \"ok\"");
  assert.equal((await provider.exec("a", "pwd -P", { cwd: scratch })).stdout.trim().endsWith(scratch.split("/").at(-1)!), true);

  // Larger than one chunk, so the append path runs too.
  const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
  await provider.writeFile("a", join(scratch, "dir/binary.bin"), bytes);
  assert.deepEqual(await provider.readFile("a", join(scratch, "dir/binary.bin")), bytes);
  await provider.writeFile("a", join(scratch, "empty.txt"), "");
  assert.equal((await provider.readFile("a", join(scratch, "empty.txt"))).length, 0);
  await assert.rejects(provider.readFile("a", join(scratch, "nope")), kind("not_found"));
});

test("morph maps SDK errors by status without their bodies", async () => {
  const { client, failWith } = fake();
  const provider = morph({ client, snapshot: "snapshot_base" });
  failWith(http(429));
  await assert.rejects(provider.exec("a", "true"), kind("unavailable", 429));
  failWith(http(503));
  await assert.rejects(provider.create(), kind("unavailable", 503));
  failWith(http(401));
  await assert.rejects(provider.exec("a", "true"), kind("rejected", 401));
  failWith(new TypeError("fetch failed"));
  await assert.rejects(provider.exec("a", "true"), kind("unavailable"));
  failWith(new Error("Command execution timed out after 1 second"));
  await assert.rejects(provider.exec("a", "true"), kind("timeout"));
  await assert.rejects(provider.exec("missing", "true"), kind("not_found", 404));
  await provider.destroy("a");
  await provider.destroy("a"); // twice is fine
  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(provider.exec("b", "true", { signal: aborted }), /stop/);
});

test("morph reuses an idempotent create, builds the base snapshot once and resolves snapshot names", async () => {
  const { calls, client } = fake();
  const provider = morph({ client });
  const first = await provider.create({ idempotencyKey: "k1", labels: { team: "z" } });
  const again = await provider.create({ idempotencyKey: "k1", labels: { team: "z" } });
  assert.equal(again.id, first.id);
  await provider.create();
  assert.equal(calls.filter(call => call.method === "snapshots.create").length, 1, "the base snapshot is built once");
  const base = (calls.find(call => call.method === "start")!.args[0] as { snapshotId: string }).snapshotId;
  assert.match(base, /^base-[a-f0-9]{64}$/);

  await provider.snapshot(first.id, "saved");
  assert.deepEqual(await provider.listSnapshots(), ["saved"]);
  await provider.create({ image: "saved" });
  assert.match((calls.filter(call => call.method === "start").at(-1)!.args[0] as { snapshotId: string }).snapshotId, /^snapshot_/);
  await provider.deleteSnapshot("saved");
  assert.deepEqual(await provider.listSnapshots(), []);

  await provider.setTtl(first.id, 1_800);
  const expires = (await provider.get(first.id))!.expiresAt!.getTime() - Date.now();
  assert.ok(expires > 1_700_000 && expires < 1_900_000);
  assert.equal((await provider.portUrl(first.id, 8765)).url.startsWith("https://"), true);
  assert.equal(calls.filter(call => call.method === "exec").length, 0);
});
