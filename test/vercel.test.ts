// Vercel Sandbox mapping through a substituted SDK (no account needed): label filtering, exit codes, files,
// idempotent create and error mapping.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APIError } from "@vercel/sandbox";
import { SandboxError } from "../src/errors.ts";
import { vercel, type VercelSdk } from "../src/providers/vercel.ts";

const apiError = (status: number, code?: string, headers: Record<string, string> = {}) =>
  new APIError(new Response("{}", { status, headers }), { json: { error: { code, message: "secret provider text" } } });

test("vercel maps labels, commands, files and failures", async () => {
  const files = new Map<string, Buffer>();
  const commands: { cmd: string; args?: string[]; env?: Record<string, string>; cwd?: string; detached?: boolean }[] = [];
  const created: Record<string, unknown>[] = [];
  const fake = (name: string, status: string, tags: Record<string, string>) => ({
    name, status, tags, createdAt: new Date(0), expiresAt: new Date(Date.now() + 60_000), routes: [{ port: 3000, subdomain: "sb-3000" }],
    domain: (port: number) => { if (port !== 3000) throw new Error("No route"); return "https://sb-3000.vercel.run"; },
    async runCommand(params: { cmd: string; args?: string[]; env?: Record<string, string>; cwd?: string; detached?: boolean }) {
      commands.push(params);
      const script = params.args![1]!;
      if (script === "busy") throw apiError(503, "capacity", { "retry-after": "7" });
      const exitCode = /^exit (\d+)$/.exec(script)?.[1];
      return { exitCode: Number(exitCode ?? 0), stdout: async () => "out", stderr: async () => "" };
    },
    async writeFiles(list: { path: string; content: string | Uint8Array }[]) { for (const file of list) files.set(file.path, Buffer.from(file.content)); },
    async readFileToBuffer({ path }: { path: string }) { return files.get(path) ?? null; },
  });
  const sandboxes = [fake("a", "running", { team: "x", role: "db" }), fake("b", "stopped", { team: "x", role: "web" }), fake("c", "failed", { team: "y" })];
  const listCalls: unknown[] = [];
  const sdk = {
    async list(params: { tags?: Record<string, string> }) {
      listCalls.push(params.tags);
      const [key, value] = Object.entries(params.tags ?? {})[0] ?? [];
      return { toArray: async () => sandboxes.filter(sandbox => key === undefined || sandbox.tags[key] === value) };
    },
    async get({ name }: { name: string }) {
      if (name === "gone") throw apiError(404, "not_found");
      return sandboxes.find(sandbox => sandbox.name === name) ?? (() => { throw apiError(404); })();
    },
    async create(params: { name?: string; tags: Record<string, string> }) {
      created.push(params);
      const sandbox = fake(params.name ?? "new", "running", params.tags);
      sandboxes.push(sandbox);
      return sandbox;
    },
  } as unknown as VercelSdk;
  const provider = vercel({ sdk });

  // Only one tag goes to the API; the rest is filtered locally.
  const listed = await provider.list({ labels: { team: "x", role: "web" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state, sandbox.labels]), [["b", "stopped", { team: "x", role: "web" }]]);
  assert.deepEqual(listCalls, [{ team: "x" }]);
  assert.equal((await provider.list()).find(sandbox => sandbox.id === "c")?.state, "gone");

  assert.equal(await provider.get("gone"), null);
  await provider.destroy("gone"); // destroying what is gone is not an error

  const result = await provider.exec("a", "exit 3", { env: { Q: `it's "quoted"` }, cwd: "/tmp" });
  assert.deepEqual(result, { exitCode: 3, stdout: "out", stderr: "" });
  const { cmd, args, env, cwd } = commands.at(-1)!;
  assert.deepEqual({ cmd, args, env, cwd }, { cmd: "bash", args: ["-c", "exit 3"], env: { Q: `it's "quoted"` }, cwd: "/tmp" });

  await assert.rejects(provider.exec("a", "busy"), (error: unknown) => error instanceof SandboxError &&
    error.kind === "unavailable" && error.code === "capacity" && error.retryAfter === 7 && !error.message.includes("secret"));
  await assert.rejects(provider.exec("missing", "true"), (error: unknown) => error instanceof SandboxError && error.kind === "not_found");

  await provider.writeFile("a", "/tmp/x/a.bin", new Uint8Array([0, 255]));
  assert.deepEqual(await provider.readFile("a", "/tmp/x/a.bin"), new Uint8Array([0, 255]));
  await assert.rejects(provider.readFile("a", "/nope"), (error: unknown) => error instanceof SandboxError && error.kind === "not_found");

  assert.deepEqual(await provider.portUrl("a", 3000), { url: "https://sb-3000.vercel.run" });

  // The idempotency key becomes the name: the second create finds the first sandbox.
  const first = await provider.create({ labels: { team: "z" }, idempotencyKey: "k1" });
  const second = await provider.create({ labels: { team: "z" }, idempotencyKey: "k1" });
  assert.equal(first.id, second.id);
  assert.equal(created.length, 1);
  assert.deepEqual(first.labels, { team: "z" });
  await assert.rejects(provider.create({ labels: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" } }),
    (error: unknown) => error instanceof SandboxError && error.kind === "rejected" && error.code === "too_many_labels");
});
