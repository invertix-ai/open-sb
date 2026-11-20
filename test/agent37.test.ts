// Agent37 request shapes and error mapping, through a substituted fetch (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxError } from "../src/errors.ts";
import { agent37 } from "../src/providers/agent37.ts";

test("agent37 maps requests, labels, files and failures", async () => {
  const calls: { url: string; method: string; body?: { command?: string }; headers: Headers }[] = [];
  const files = new Map<string, string>();
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input), body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? "GET", body, headers: new Headers(init.headers) });
    if (url.endsWith("/instances") && init.method === "GET")
      return Response.json({ data: [{ id: "i1", status: "sleeping", metadata: { team: "a", n: 1 } }, { id: "i2", status: "running", metadata: { team: "b" } }] });
    if (url.endsWith("/instances/gone")) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (url.endsWith("/instances/busy/sleep")) return Response.json({ error: "capacity" }, { status: 503 });
    if (url.endsWith("/exec")) {
      // A tiny shell: enough for writeFile's chunked base64 and readFile.
      const command: string = body.command;
      let match;
      if ((match = /^printf %s '([^']*)' >> '([^']*)'$/.exec(command))) files.set(match[2]!, (files.get(match[2]!) ?? "") + match[1]);
      else if ((match = /^base64 -d '([^']*)' > .* && mv -f .* '([^']*)' && rm/.exec(command))) files.set(match[2]!, Buffer.from(files.get(match[1]!)!, "base64").toString());
      else if ((match = /^base64 -w0 -- '([^']*)'$/.exec(command)))
        return Response.json(files.has(match[1]!) ? { exit_code: 0, stdout: Buffer.from(files.get(match[1]!)!).toString("base64") } : { exit_code: 1, stdout: "" });
      return Response.json({ exit_code: 0, stdout: "", stderr: "" });
    }
    return Response.json({});
  }) as typeof globalThis.fetch;
  const provider = agent37({ apiKey: "key", fetch });

  const listed = await provider.list({ labels: { team: "a" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state, sandbox.labels]), [["i1", "stopped", { team: "a" }]]);
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer key");

  assert.equal(await provider.get("gone"), null);
  await assert.rejects(provider.pause("busy"), (error: unknown) => error instanceof SandboxError && error.kind === "unavailable" && error.code === "capacity");

  await provider.writeFile("i2", "/data/a.txt", "x".repeat(100_000));
  assert.equal(Buffer.from(await provider.readFile("i2", "/data/a.txt")).toString(), "x".repeat(100_000));
  const exec = calls.find(call => call.url.endsWith("/exec"))!;
  assert.equal(exec.headers.get("x-agent37-key"), "key");
  await assert.rejects(provider.readFile("i2", "/missing"), (error: unknown) => error instanceof SandboxError && error.kind === "not_found");

  await provider.exec("i2", "pwd", { cwd: "/tmp/it's", env: { A: "b c" } });
  assert.equal(calls.at(-1)!.body!.command, `export A='b c' && cd '/tmp/it'\\''s' && pwd`);
});
