// Fly Machines request shapes and error mapping, through a substituted fetch (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxError } from "../src/errors.ts";
import { fly } from "../src/providers/fly.ts";

interface Call { url: URL; method: string; body?: { command?: string[]; stdin?: string; timeout?: number; name?: string; config?: { metadata?: object } }; headers: Headers }

function fake() {
  const calls: Call[] = [];
  const files = new Map<string, Buffer>();
  let limited = 1;
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, headers: new Headers(init.headers) });
    const path = url.pathname;
    if (path === "/v1/apps/sandboxes/machines" && method === "GET") {
      // Two pages; the second machine shares a key but not the value, so only the local filter drops it.
      if (!url.searchParams.has("cursor"))
        return Response.json([{ id: "m1", state: "suspended", config: { metadata: { team: "a", fly_platform_version: "v2", n: 1 } } }],
          { headers: { "fly-next-cursor": "next" } });
      return Response.json([{ id: "m2", state: "started", config: { metadata: { team: "ab" } } }, { id: "m3", state: "started", config: { metadata: { "open-sb.idempotency-key": "k1" } } }]);
    }
    if (path === "/v1/apps/sandboxes/machines" && method === "POST")
      return body.name ? Response.json({ error: "already exists", status: "name_taken" }, { status: 409 }) : Response.json({ id: "new", state: "created", config: body.config });
    if (path.endsWith("/machines/gone")) return Response.json({ error: "not found" }, { status: 404 });
    if (path.endsWith("/machines/busy/suspend")) return Response.json({ error: "no capacity", status: "insufficient_capacity" }, { status: 503 });
    if (path.endsWith("/machines/slow/start") && limited-- > 0) return Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "0" } });
    if (path.endsWith("/exec")) {
      // A tiny shell: enough for writeFile's stdin chunks, readFile and exit codes.
      const script = body.command[2] as string;
      let match;
      if (script === "exit 3") return Response.json({ exit_code: 3, exit_signal: 0, stdout: "", stderr: "" });
      if (script === "sleep 100") return Response.json({ exit_code: -1, exit_signal: 9, stdout: "", stderr: "" });
      if ((match = /^base64 -d >> '([^']*)'$/.exec(script))) files.set(match[1]!, Buffer.concat([files.get(match[1]!) ?? Buffer.alloc(0), Buffer.from(body.stdin, "base64")]));
      else if ((match = /^mv -f '([^']*)' '([^']*)'$/.exec(script))) files.set(match[2]!, files.get(match[1]!)!);
      else if ((match = /^wc -c < '([^']*)'$/.exec(script)))
        return Response.json(files.has(match[1]!) ? { exit_code: 0, stdout: `${files.get(match[1]!)!.length}\n` } : { exit_code: 1, stdout: "" });
      else if ((match = /^tail -c \+(\d+) -- '([^']*)' \| head -c (\d+) \| base64/.exec(script))) {
        const start = Number(match[1]) - 1;
        return Response.json({ exit_code: 0, stdout: files.get(match[2]!)!.subarray(start, start + Number(match[3])).toString("base64") });
      }
      return Response.json({ exit_code: 0, exit_signal: 0, stdout: "", stderr: "" });
    }
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("fly filters labels exactly, maps exit codes and errors, and moves files", async () => {
  const { calls, fetch } = fake();
  const provider = fly({ apiToken: "token", app: "sandboxes", fetch });

  const listed = await provider.list({ labels: { team: "a" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state, sandbox.labels]), [["m1", "stopped", { team: "a" }]]);
  assert.equal(calls[0]!.url.searchParams.get("metadata.team"), "a");
  assert.equal(calls[1]!.url.searchParams.get("cursor"), "next");
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer token");

  // A retried create hits `name_taken` and finds the machine carrying the same key.
  assert.equal((await provider.create({ idempotencyKey: "k1" })).id, "m3");
  const created = await provider.create({ labels: { team: "c" } });
  assert.deepEqual([created.state, created.labels], ["starting", { team: "c" }]);

  assert.equal(await provider.get("gone"), null);
  await provider.destroy("gone");
  await assert.rejects(provider.pause("busy"), (error: unknown) =>
    error instanceof SandboxError && error.kind === "unavailable" && error.code === "insufficient_capacity" && !error.message.includes("no capacity"));
  await provider.resume("slow"); // one 429, then retried

  assert.equal((await provider.exec("m2", "exit 3")).exitCode, 3);
  assert.equal((await provider.exec("m2", "sleep 100")).exitCode, 137);
  await provider.exec("m2", "pwd", { cwd: "/tmp/it's", env: { A: "b c" }, timeoutMs: 5_500 });
  assert.deepEqual(calls.at(-1)!.body!.command, ["/bin/sh", "-c", `export A='b c' && cd '/tmp/it'\\''s' && pwd`]);
  assert.equal(calls.at(-1)!.body!.timeout, 6);
  await assert.rejects(provider.exec("m2", "true", { timeoutMs: 700_000 }), (error: unknown) => error instanceof SandboxError && error.kind === "rejected");

  const bytes = new Uint8Array(1_500_000).map((_, index) => index % 256);
  await provider.writeFile("m2", "/data/a.bin", bytes);
  assert.deepEqual(await provider.readFile("m2", "/data/a.bin"), bytes);
  await assert.rejects(provider.readFile("m2", "/missing"), (error: unknown) => error instanceof SandboxError && error.kind === "not_found");
});
