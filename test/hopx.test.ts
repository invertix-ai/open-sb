// HOPX label emulation, exit codes and error mapping, through a substituted SDK (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { APIError, AuthenticationError, RateLimitError, SandboxExpiredError, ServerError } from "@hopx-ai/sdk";
import { SandboxError } from "../src/errors.ts";
import { hopx, type HopxSandbox, type HopxSdk } from "../src/providers/hopx.ts";

interface Vm { status: string; files: Map<string, Buffer>; expires_at?: string }

function fake() {
  const vms = new Map<string, Vm>();
  const commands: { command: string; options: unknown }[] = [];
  let failNext: Error | undefined;
  const connection = (id: string): HopxSandbox => ({
    sandboxId: id,
    commands: {
      async run(command, options) {
        commands.push({ command, options });
        if (command === "exit 3") return { success: false, stdout: "out", stderr: "err", exit_code: 3, execution_time: 0 };
        return { success: true, stdout: command, stderr: "", exit_code: 0, execution_time: 0 };
      },
    },
    files: {
      async readBytes(path) {
        const bytes = vms.get(id)!.files.get(path);
        if (!bytes) throw new APIError("404 body with secret", undefined, undefined, 404);
        return bytes;
      },
      async writeBytes(path, content) { vms.get(id)!.files.set(path, content); },
    },
    async getPreviewUrl(port) { return `https://${port}-${id}.eu-1001.vms.hopx.dev/`; },
  });
  const sdk: HopxSdk = {
    api: {
      async get<T>(url: string) {
        if (failNext) { const error = failNext; failNext = undefined; throw error; }
        if (url.startsWith("/v1/sandboxes?")) {
          const all = [...vms.entries()].map(([id, vm]) => ({ id, status: vm.status, created_at: "2026-11-20T10:00:00Z" }));
          // Two pages: the provider must follow the cursor.
          return (url.includes("cursor=") ? { data: all.slice(2), has_more: false } : { data: all.slice(0, 2), has_more: true, next_cursor: "c2" }) as T;
        }
        const id = decodeURIComponent(url.split("/")[3]!);
        const vm = vms.get(id);
        if (!vm) throw new SandboxExpiredError("Sandbox not found: body with secret", {});
        return { id, status: vm.status, expires_at: vm.expires_at } as T;
      },
      async post<T>(url: string) {
        const vm = vms.get(url.split("/")[3]!)!;
        if (url.endsWith("/pause")) vm.status = "paused";
        if (url.endsWith("/resume")) vm.status = "running";
        return {} as T;
      },
      async put<T>(url: string, data?: unknown) {
        vms.get(url.split("/")[3]!)!.expires_at = new Date(Date.now() + (data as { timeout_seconds: number }).timeout_seconds * 1000).toISOString();
        return {} as T;
      },
      async delete<T>(url: string) {
        if (!vms.delete(url.split("/")[3]!)) throw new SandboxExpiredError("gone: body", {});
        return {} as T;
      },
    },
    async create() {
      const id = `vm${vms.size + 1}`;
      vms.set(id, { status: "running", files: new Map() });
      return connection(id);
    },
    async connect(id) {
      const vm = vms.get(id);
      if (!vm) throw new SandboxExpiredError("gone: body", {});
      vm.status = "running";
      return connection(id);
    },
  };
  return { sdk, vms, commands, fail: (error: Error) => { failNext = error; } };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("body"), "provider bodies must not reach the message");
  return true;
};

test("hopx keeps signed labels in the VM and filters exactly", async () => {
  const { sdk, vms } = fake();
  const provider = hopx({ apiKey: "key", sdk });
  const a = await provider.create({ labels: { team: "x" } });
  await provider.create({ labels: { team: "y" } });
  const c = await provider.create({ labels: { team: "x", other: "1" } });
  // A sandbox rewrites its own label file to join team x: the signature no longer matches.
  vms.get("vm2")!.files.set("/var/lib/open-sb/labels.json", Buffer.from(JSON.stringify({ labels: { team: "x" }, signature: "0".repeat(64) })));
  assert.deepEqual((await provider.list({ labels: { team: "x" } })).map(sandbox => sandbox.id), [a.id, c.id]);

  // Another process with the same key reads the files; one it cannot verify has no labels.
  const other = hopx({ apiKey: "key", sdk });
  assert.deepEqual((await other.list({ labels: { team: "x" } })).map(sandbox => sandbox.id), [a.id, c.id]);
  assert.deepEqual((await other.get("vm2"))?.labels, {});
  assert.deepEqual((await hopx({ apiKey: "other-key", sdk }).list({ labels: { team: "x" } })), []);

  // A paused sandbox's file is unreadable: known labels still match, unknown ones do not.
  await provider.pause(a.id);
  assert.equal((await provider.get(a.id))?.state, "stopped");
  assert.deepEqual((await provider.list({ labels: { team: "x" } })).map(sandbox => sandbox.id), [a.id, c.id]);
  assert.deepEqual((await hopx({ apiKey: "key", sdk }).list({ labels: { team: "x" } })).map(sandbox => sandbox.id), [c.id]);
  assert.equal(vms.get(a.id)!.status, "paused", "listing must not resume sandboxes");
  assert.equal((await provider.list()).length, 3);
});

test("hopx reports exit codes and passes env and cwd as data", async () => {
  const { sdk, commands } = fake();
  const provider = hopx({ apiKey: "key", sdk });
  const { id } = await provider.create();
  assert.deepEqual(await provider.exec(id, "exit 3"), { exitCode: 3, stdout: "out", stderr: "err" });
  await provider.exec(id, "printenv", { env: { GREETING: "it's ok" }, cwd: "/tmp", timeoutMs: 10_500 });
  assert.deepEqual(commands.at(-1), { command: "printenv", options: { timeout: 11, workingDir: "/tmp", env: { GREETING: "it's ok" } } });
  await provider.writeFile(id, "/tmp/it's/a.bin", new Uint8Array([0, 255]));
  assert.equal(commands.at(-1)!.command, `mkdir -p -- '/tmp/it'\\''s'`);
  assert.deepEqual(await provider.readFile(id, "/tmp/it's/a.bin"), new Uint8Array([0, 255]));
  await provider.startBackground(id, "sleep 9; echo 'done'");
  assert.equal(commands.at(-1)!.command, `nohup setsid bash -c 'sleep 9; echo '\\''done'\\''' </dev/null >/dev/null 2>&1 &`);
  await provider.setTtl(id, 1_800);
  const seconds = ((await provider.get(id))!.expiresAt!.getTime() - Date.now()) / 1000;
  assert.ok(seconds > 1_790 && seconds <= 1_800);
  assert.equal((await provider.portUrl(id, 8080)).url, `https://8080-${id}.eu-1001.vms.hopx.dev/`);
});

test("hopx maps errors, honours idempotency keys and aborts", async () => {
  const { sdk, fail } = fake();
  const provider = hopx({ apiKey: "key", sdk });
  const first = await provider.create({ idempotencyKey: "retry-1", labels: { a: "b" } });
  const again = await provider.create({ idempotencyKey: "retry-1", labels: { a: "b" } });
  assert.equal(again.id, first.id);
  assert.deepEqual(first.labels, { a: "b" }, "the idempotency label stays internal");

  assert.equal(await provider.get("missing"), null);
  await provider.destroy(first.id);
  await provider.destroy(first.id); // twice is fine
  await assert.rejects(provider.readFile("missing", "/x"), kind("not_found"));
  fail(new RateLimitError("Rate limit: body"));
  await assert.rejects(provider.get("vm1"), kind("unavailable", 429));
  fail(new ServerError("boom: body"));
  await assert.rejects(provider.get("vm1"), kind("unavailable", 500));
  fail(new APIError("connect ECONNREFUSED: body"));
  await assert.rejects(provider.get("vm1"), kind("unavailable"));
  fail(new AuthenticationError("bad key: body"));
  await assert.rejects(provider.list(), kind("rejected", 401));
  fail(new APIError("bad template: body", undefined, undefined, 400));
  await assert.rejects(provider.get("vm1"), kind("rejected", 400));

  await assert.rejects(provider.get("vm1", { signal: AbortSignal.abort(new Error("caller gave up")) }), /caller gave up/);
});
