// Sprites label filtering, exit codes and error mapping, through a substituted SDK client (no account needed).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ExecError, FilesystemError, parseAPIError } from "@fly/sprites";
import { SandboxError } from "../src/errors.ts";
import { sprites, type SpritesSdk } from "../src/providers/sprites.ts";

const record = (name: string, labels: string[], status = "cold") => ({ name, labels, status, createdAt: new Date(0) });

function fake() {
  const calls: { method: string; args: unknown[] }[] = [];
  const existing = new Set(["a", "b", "c"]);
  let execs: (() => Promise<unknown>)[] = [];
  const client = {
    async createSprite(id: string, opts: unknown) {
      calls.push({ method: "create", args: [id, opts] });
      if (existing.has(id)) throw parseAPIError(400, '{"error":"name_taken","message":"body with secret"}');
      existing.add(id);
      return record(id, (opts as { labels: string[] }).labels);
    },
    async getSprite(id: string) {
      if (id === "flaky") throw new Error("Network error: fetch failed body");
      if (!existing.has(id)) throw parseAPIError(404, '{"error":"not_found","message":"body"}');
      return record(id, ["k=v"]);
    },
    async listSprites(opts: { continuationToken?: string }) {
      calls.push({ method: "list", args: [opts] });
      // Two pages, unfiltered: the provider must filter labels exactly.
      return opts.continuationToken
        ? { sprites: [record("c", ["team=x", "other=1"], "warm")], hasMore: false }
        : { sprites: [record("a", ["team=x"], "running"), record("b", ["team=y", "x"])], hasMore: true, nextContinuationToken: "t" };
    },
    async deleteSprite(id: string) {
      if (id === "limited") throw parseAPIError(429, '{"error":"rate_limited","message":"body"}', { "retry-after": "7" });
      if (!existing.has(id)) throw parseAPIError(404, "body");
    },
    sprite(id: string) {
      return {
        execFile: (file: string, args: string[], opts: unknown) => {
          calls.push({ method: "exec", args: [id, file, args, opts] });
          return (execs.shift() ?? (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })))();
        },
        filesystem: () => ({
          readFile: async () => { throw new FilesystemError("body", "ENOENT", "/x", "read"); },
          writeFile: async () => { throw new FilesystemError("body", "UNKNOWN", "/x", "write"); },
        }),
        createSession: (file: string, args: string[], opts: unknown) => {
          calls.push({ method: "session", args: [id, file, args, opts] });
          const session = Object.assign(new EventEmitter(), { close: () => calls.push({ method: "close", args: [] }) });
          setImmediate(() => session.emit("spawn"));
          return session;
        },
      };
    },
  };
  return { calls, existing, client: client as unknown as SpritesSdk, setExecs: (next: typeof execs) => { execs = next; } };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("body"), "provider bodies must not reach the message");
  return true;
};

test("sprites filters labels exactly across pages", async () => {
  const provider = sprites({ token: "t", client: fake().client });
  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(sprite => [sprite.id, sprite.state]), [["a", "running"], ["c", "running"]]);
  assert.deepEqual(listed[1]!.labels, { team: "x", other: "1" });
  assert.equal((await provider.list()).length, 3);
});

test("sprites reports exit codes and maps errors", async () => {
  const { calls, client, setExecs } = fake();
  const provider = sprites({ token: "t", client });

  setExecs([async () => { throw new ExecError("exit 3", { exitCode: 3, stdout: "out", stderr: "err" }); }]);
  assert.deepEqual(await provider.exec("a", "exit 3"), { exitCode: 3, stdout: "out", stderr: "err" });
  await provider.exec("a", "echo hi there", { env: { A: "it's" }, cwd: "/tmp" });
  const [, file, args, opts] = calls.at(-1)!.args as [string, string, string[], { env: unknown; cwd: string }];
  assert.deepEqual([file, args, opts.env, opts.cwd], ["sh", ["-c", "echo hi there"], { A: "it's" }, "/tmp"]);

  // A socket failure on a sprite that is gone is not_found; on a live one it is an outage.
  setExecs([async () => { throw new Error("WebSocket error: x (url: secret)"); }]);
  await assert.rejects(provider.exec("gone", "true"), kind("not_found"));
  setExecs([async () => { throw new Error("WebSocket error: x (url: secret)"); }]);
  await assert.rejects(provider.exec("a", "true"), kind("unavailable"));
  setExecs([() => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 50))]);
  await assert.rejects(provider.exec("a", "sleep 9", { timeoutMs: 1 }), kind("timeout"));

  assert.equal(await provider.get("gone"), null);
  await assert.rejects(provider.get("flaky"), kind("unavailable"));
  await assert.rejects(provider.destroy("limited"), (error: unknown) => kind("unavailable", 429)(error) && (error as SandboxError).retryAfter === 7);
  await provider.destroy("gone"); // already gone is fine
  await assert.rejects(provider.readFile("a", "/x"), kind("not_found"));
  await assert.rejects(provider.writeFile("a", "/x", "y"), kind("unavailable"));
  await assert.rejects(provider.create({ image: "ubuntu" }), kind("rejected"));
  await assert.rejects(provider.create({ labels: { "a=b": "c" } }), kind("rejected"));

  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(provider.get("a", { signal: aborted }), /stop/);
});

test("sprites turns idempotency keys into one deterministic name and encodes labels", async () => {
  const { calls, client } = fake();
  const provider = sprites({ token: "t", client });
  const first = await provider.create({ idempotencyKey: "Retry Me!", labels: { team: "x", quote: "it's=ok" } });
  assert.match(first.id, /^open-sb-[a-f0-9]{32}$/);
  assert.deepEqual(first.labels, { team: "x", quote: "it's=ok" });
  assert.deepEqual((calls[0]!.args[1] as { labels: string[] }).labels, ["team=x", "quote=it's=ok"]);
  const again = await provider.create({ idempotencyKey: "Retry Me!" });
  assert.equal(again.id, first.id);
  assert.equal(calls.filter(call => call.method === "create").length, 1, "a retried key does not create twice");
  const other = await provider.create();
  assert.notEqual(other.id, first.id);
});

test("sprites starts background commands in a detached session", async () => {
  const { calls, client } = fake();
  await sprites({ token: "t", client }).startBackground("a", "sleep 2; echo done", { cwd: "/tmp" });
  assert.deepEqual(calls.map(call => call.method), ["session", "close"]);
  assert.deepEqual(calls[0]!.args.slice(1, 3), ["sh", ["-c", "sleep 2; echo done"]]);
});
