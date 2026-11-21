// Upstash Box label emulation, exit codes and error mapping, through substituted SDK statics (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxError } from "@upstash/box";
import { SandboxError } from "../src/errors.ts";
import { upstash, type UpstashSdk } from "../src/providers/upstash.ts";

interface Stored { id: string; name?: string; status: string; labels: string[]; initCommand: string }

function fake() {
  const boxes = new Map<string, Stored>();
  const calls: { method: string; args: unknown[] }[] = [];
  let runs: ((command: string) => Promise<unknown>)[] = [];
  let failures: Record<string, () => never> = {};
  const handle = (stored: Stored) => ({
    id: stored.id,
    keepAlive: false,
    async getStatus() { return { status: stored.status }; },
    async getInitCommand() { return stored.initCommand; },
    async pause() { failures.pause?.(); stored.status = "paused"; },
    async resume() { stored.status = "idle"; },
    exec: {
      command: (command: string) => {
        calls.push({ method: "exec", args: [command] });
        return (runs.shift() ?? (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })))(command);
      },
    },
  });
  const sdk = {
    async create(config: { name?: string; labels?: string[]; initCommand?: string }) {
      calls.push({ method: "create", args: [config] });
      const stored = { id: `box-${boxes.size + 1}`, name: config.name, status: "idle", labels: config.labels ?? [], initCommand: config.initCommand ?? "" };
      boxes.set(stored.id, stored);
      return handle(stored);
    },
    async get(id: string) {
      const stored = boxes.get(id) ?? [...boxes.values()].find(box => box.name === id);
      if (!stored) throw new BoxError("Box not found: body with secret", 404);
      return handle(stored);
    },
    async list(options: { label?: string }) {
      calls.push({ method: "list", args: [options] });
      failures.list?.();
      // A server that ignores the label filter: the provider must still filter exactly.
      return [...boxes.values()].map(box => ({ id: box.id, status: box.status, labels: box.labels, created_at: 1_700_000_000, updated_at: 0 }));
    },
    async delete(options: { boxIds: string }) {
      failures.delete?.();
      if (!boxes.delete(options.boxIds)) throw new BoxError("not found - body", 404);
    },
  };
  return {
    boxes, calls, sdk: sdk as unknown as UpstashSdk,
    setRuns: (next: typeof runs) => { runs = next; },
    setFailures: (next: typeof failures) => { failures = next; },
  };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("body"), "provider bodies must not reach the message");
  return true;
};

test("upstash stores labels as hashed native labels and filters list exactly", async () => {
  const { boxes, calls, sdk } = fake();
  const provider = upstash({ apiKey: "key", sdk });
  const a = await provider.create({ labels: { "open-sb.conformance": "a-long-value-with-'quotes'", team: "x" } });
  await provider.create({ labels: { team: "y" } });
  await provider.create();
  // Hashed labels fit the API's limits.
  for (const tag of boxes.get(a.id)!.labels) assert.match(tag, /^[A-Za-z0-9._:-]{1,20}$/);
  // A box whose native labels match but whose stored values do not (a hash collision) is still excluded.
  boxes.set("forged", { ...boxes.get(a.id)!, id: "forged", initCommand: ": open-sb-labels " + Buffer.from('{"team":"z"}').toString("base64url") });

  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(sandbox => sandbox.id), [a.id]);
  assert.deepEqual(listed[0]!.labels, { "open-sb.conformance": "a-long-value-with-'quotes'", team: "x" });
  assert.equal(listed[0]!.createdAt?.getTime(), 1_700_000_000_000);
  assert.match((calls.findLast(call => call.method === "list")!.args[0] as { label: string }).label, /^osb:/);
  assert.equal((await provider.list()).length, 4);
  assert.deepEqual((await provider.get(a.id))?.labels.team, "x");
  await assert.rejects(provider.create({ labels: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" } }), kind("rejected"));
});

test("upstash reports exit codes, quotes env and maps errors", async () => {
  const { calls, sdk, setRuns, setFailures } = fake();
  const provider = upstash({ apiKey: "key", sdk });
  const { id } = await provider.create();

  setRuns([async () => ({ exitCode: 3, stdout: "out", stderr: "err" })]);
  assert.deepEqual(await provider.exec(id, "exit 3"), { exitCode: 3, stdout: "out", stderr: "err" });
  await provider.exec(id, 'printf %s "$A"', { env: { A: "it's" }, cwd: "/tmp/x y" });
  assert.equal(calls.at(-1)!.args[0], `export A='it'\\''s'\ncd '/tmp/x y' || exit 1\nprintf %s "$A"`);
  await assert.rejects(provider.exec(id, "true", { env: { "A;rm": "x" } }), /Invalid environment/);

  setRuns([async () => ({ exitCode: 124, stdout: "", stderr: "" })]);
  await assert.rejects(provider.exec(id, "sleep 999", { timeoutMs: 1000 }), kind("timeout"));
  assert.match(calls.at(-1)!.args[0] as string, /^exec timeout -k 5 1 sh -c 'sleep 999'$/);
  setRuns([async () => { throw new BoxError("Request timeout"); }]);
  await assert.rejects(provider.exec(id, "sleep 999"), kind("timeout"));
  setRuns([async () => { throw new BoxError("fetch failed: body"); }]);
  await assert.rejects(provider.exec(id, "true"), kind("unavailable"));

  assert.equal(await provider.get("gone"), null);
  await provider.destroy("gone"); // destroying a missing box is fine
  setFailures({ pause: () => { throw new BoxError("Too many requests - body", 429); } });
  await assert.rejects(provider.pause(id), kind("unavailable", 429));
  setFailures({ delete: () => { throw new BoxError("Unauthorized - body", 401); }, list: () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(provider.destroy(id), kind("rejected", 401));
  await assert.rejects(provider.list(), kind("unavailable"));

  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(provider.get(id, { signal: aborted }), /stop/);
});

test("upstash pause and resume skip boxes already in that state", async () => {
  const { boxes, sdk } = fake();
  const provider = upstash({ apiKey: "key", sdk });
  const { id } = await provider.create();
  await provider.pause(id);
  assert.equal((await provider.get(id))?.state, "stopped");
  await provider.pause(id);
  await provider.resume(id);
  assert.equal(boxes.get(id)!.status, "idle");
  assert.equal((await provider.get(id))?.state, "running");
});

test("upstash turns an idempotency key into a box name and reuses the box", async () => {
  const { calls, sdk } = fake();
  const provider = upstash({ apiKey: "key", sdk });
  const first = await provider.create({ idempotencyKey: "retry me", labels: { a: "b" } });
  const again = await provider.create({ idempotencyKey: "retry me", labels: { a: "b" } });
  assert.equal(again.id, first.id);
  assert.deepEqual(again.labels, { a: "b" });
  const creates = calls.filter(call => call.method === "create");
  assert.equal(creates.length, 1);
  assert.match((creates[0]!.args[0] as { name: string }).name, /^open-sb-[a-f0-9]{32}$/);
  await assert.rejects(provider.create({ image: "ubuntu:24.04" }), kind("rejected"));
});
