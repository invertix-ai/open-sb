// Blaxel label filtering, states, exec results and error mapping, through a substituted client (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxError } from "../src/errors.ts";
import { blaxel, type BlaxelClient, type BlaxelSandbox } from "../src/providers/blaxel.ts";

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("secret"), "provider bodies must not reach the message");
  return true;
};

function fake() {
  const execs: unknown[] = [];
  const lifecycles: unknown[] = [];
  let results: { status: string; exitCode: number; stdout: string; stderr: string }[] = [];
  const sandboxes = new Map<string, BlaxelSandbox>();
  const make = (name: string, status: string, labels: Record<string, string>, expiresIn?: number): BlaxelSandbox => {
    const sandbox: BlaxelSandbox = {
      metadata: { name, labels, createdAt: "2026-11-20T10:00:00Z" }, status, expiresIn,
      spec: { lifecycle: { expirationPolicies: [{ type: "ttl-idle", value: "1h", action: "delete" }, { type: "date", value: "old", action: "delete" }] } },
      fs: { async readBinary() { return new Blob([new Uint8Array([0, 255])]); }, async writeBinary() { return {}; } },
      process: {
        async exec(request) { execs.push(request); return { pid: "1", status: "running", exitCode: 0, stdout: "", stderr: "" }; },
        async wait() {
          const next = results.shift();
          if (!next) throw new Error("Process did not finish in time");
          return { pid: "1", ...next };
        },
        async logs(_id, type) { return `full ${type}`; },
        async kill() { return {}; },
      },
      previews: {
        async createIfNotExists() {
          return { url: `https://preview.bl.run/${name}`, spec: { public: false }, tokens: { async createIfExpired() { return { value: "tok" }; } } };
        },
      },
    };
    sandboxes.set(name, sandbox);
    return sandbox;
  };
  make("a", "DEPLOYED", { team: "x" });
  make("b", "ARCHIVED", { team: "x", other: "1" }, 600);
  make("c", "DEPLOYED", { team: "y" });
  make("d", "TERMINATED", { team: "x" });
  const missing = (sandboxName: string) => { throw { error: `sandbox ${sandboxName} not found: secret`, code: 404 }; };
  const client: BlaxelClient = {
    async create(config) { return make(config.name ?? "generated", "DEPLOYED", config.labels ?? {}); },
    async createIfNotExists(config) { return sandboxes.get(config.name!) ?? make(config.name!, "DEPLOYED", config.labels ?? {}); },
    async get(sandboxName) {
      if (sandboxName === "busy") throw { error: { code: "UPSTREAM_TIMEOUT", message: "secret", status: 504 } };
      if (sandboxName === "limited") throw { code: "RATE_LIMIT_EXCEEDED", message: "secret", status_code: 429 };
      if (sandboxName === "denied") throw { code: "UNAUTHORIZED", message: "secret", status_code: 403 };
      if (sandboxName === "offline") throw new TypeError("fetch failed: secret");
      return sandboxes.get(sandboxName) ?? missing(sandboxName);
    },
    // Blaxel has no label filter, so the provider must filter exactly.
    async list() { return (async function* () { yield* sandboxes.values(); })(); },
    async delete(sandboxName) { if (!sandboxes.delete(sandboxName)) missing(sandboxName); return {}; },
    async archive(sandboxName) { sandboxes.get(sandboxName)!.status = "ARCHIVED"; return {}; },
    async unarchive(sandboxName) { sandboxes.get(sandboxName)!.status = "DEPLOYED"; return {}; },
    async updateMetadata(sandboxName, metadata) { const found = sandboxes.get(sandboxName)!; found.metadata.labels = metadata.labels; return found; },
    async updateLifecycle(_name, lifecycle) { lifecycles.push(lifecycle); return {}; },
    snapshots: {
      async create() { throw new Error("unused"); },
      async get() { throw new Error("unused"); },
      async list() { return (async function* () {})(); },
      async delete() {},
    },
  };
  return { client, execs, lifecycles, sandboxes, setResults: (next: typeof results) => { results = next; } };
}

test("blaxel filters labels exactly and maps states", async () => {
  const { client } = fake();
  const provider = blaxel({ client });
  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state]), [["a", "running"], ["b", "stopped"], ["d", "gone"]]);
  assert.equal((await provider.list()).length, 4);
  const archived = await provider.get("b");
  assert.ok(archived?.expiresAt && Math.abs(archived.expiresAt.getTime() - Date.now() - 600_000) < 5_000);
  assert.equal(await provider.get("missing"), null);
});

test("blaxel reports exit codes, long output and timeouts", async () => {
  const { client, execs, setResults } = fake();
  const provider = blaxel({ client });
  setResults([{ status: "failed", exitCode: 3, stdout: "out", stderr: "err" }]);
  assert.deepEqual(await provider.exec("a", "exit 3", { env: { A: "it's" }, cwd: "/tmp" }), { exitCode: 3, stdout: "out", stderr: "err" });
  assert.deepEqual(execs[0], { command: "exit 3", env: { A: "it's" }, workingDir: "/tmp", timeout: 600 });
  setResults([{ status: "completed", exitCode: 0, stdout: "x".repeat(64 * 1024), stderr: "" }]);
  assert.deepEqual(await provider.exec("a", "yes | head"), { exitCode: 0, stdout: "full stdout", stderr: "" });
  setResults([]);
  await assert.rejects(provider.exec("a", "sleep 999", { timeoutMs: 10 }), kind("timeout"));
  setResults([{ status: "killed", exitCode: 137, stdout: "", stderr: "" }]);
  await assert.rejects(provider.exec("a", "sleep 999"), kind("timeout"));
});

test("blaxel maps errors without provider messages", async () => {
  const { client } = fake();
  const provider = blaxel({ client });
  await assert.rejects(provider.exec("busy", "true"), kind("unavailable", 504));
  await assert.rejects(provider.readFile("limited", "/x"), kind("unavailable", 429));
  await assert.rejects(provider.readFile("denied", "/x"), kind("rejected", 403));
  await assert.rejects(provider.readFile("offline", "/x"), kind("unavailable"));
  await assert.rejects(provider.readFile("missing", "/x"), kind("not_found", 404));
  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(provider.readFile("a", "/x", { signal: aborted }), /stop/);
  await provider.destroy("a");
  await provider.destroy("a"); // destroying twice is not an error
});

test("blaxel makes creates idempotent and keeps other lifecycle policies", async () => {
  const { client, lifecycles, sandboxes } = fake();
  const provider = blaxel({ client });
  const first = await provider.create({ idempotencyKey: "Key 1!", labels: { team: "z" } });
  const again = await provider.create({ idempotencyKey: "Key 1!", labels: { team: "z" } });
  assert.equal(first.id, again.id);
  assert.match(first.id, /^osb-[a-f0-9]{40}$/);
  assert.equal(sandboxes.size, 5);
  // A sandbox holding the name without the key's label is someone else's.
  sandboxes.get(first.id)!.metadata.labels = {};
  await assert.rejects(provider.create({ idempotencyKey: "Key 1!" }), kind("rejected", 409));

  await provider.setTtl("a", 1_800);
  const policies = (lifecycles[0] as { expirationPolicies: { type: string; value: string }[] }).expirationPolicies;
  assert.deepEqual(policies.map(policy => policy.type), ["ttl-idle", "date"]);
  assert.ok(Math.abs(Date.parse(policies[1]!.value) - Date.now() - 1_800_000) < 5_000);

  assert.deepEqual(await provider.portUrl("a", 8765), { url: "https://preview.bl.run/a", headers: { "X-Blaxel-Preview-Token": "tok" } });
  await provider.pause("a");
  assert.equal((await provider.get("a"))?.state, "stopped");
  await provider.resume("a");
  assert.equal((await provider.get("a"))?.state, "running");
  assert.deepEqual(await provider.readFile("a", "/x"), new Uint8Array([0, 255]));
});
