// CodeSandbox label filtering, exit codes and error mapping (no account needed). The control API runs through the
// real SDK against a fake fetch, so HTTP statuses are mapped as in production; sessions use an injected client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxError } from "../src/errors.ts";
import { codesandbox, type CsbClient, type CsbSession } from "../src/providers/codesandbox.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sandbox = (id: string, tags: string[]) =>
  ({ id, tags, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", privacy: 1, is_frozen: false, settings: {} });

/** A CodeSandbox API that ignores the tag filter and pages its results, so the provider must filter exactly. */
function fakeApi() {
  const requests: string[] = [];
  const fetch = async (input: Request) => {
    const url = new URL(input.url);
    requests.push(`${input.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/sandbox") {
      const page = Number(url.searchParams.get("page"));
      const pages = [
        [sandbox("a", ["team=x", "sdk"]), sandbox("b", ["team=y"]), sandbox("s", ["open-sb.snapshot", "team=x"])],
        [sandbox("c", ["team=x", "other=1", "odd%E0%A4=tag"])],
      ];
      return json(200, { success: true, data: { sandboxes: pages[page - 1] ?? [],
        pagination: { current_page: page, next_page: page < pages.length ? page + 1 : null, total_records: 4 } } });
    }
    if (url.pathname === "/vm/running")
      return json(200, { success: true, data: { concurrent_vm_count: 1, concurrent_vm_limit: 10, vms: [{ id: "a" }] } });
    if (url.pathname === "/sandbox/gone" || url.pathname === "/vm/gone") return json(404, { errors: ["body with secret"] });
    if (url.pathname === "/sandbox/p") return json(200, { success: true, data: sandbox("p", ["k=v%3Dw"]) });
    if (url.pathname.endsWith("/hibernate")) return json(429, { errors: ["body with secret"] }, { "retry-after": "7" });
    if (url.pathname === "/vm/down") throw new TypeError("fetch failed");
    return json(401, { errors: ["body with secret"] });
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

const kind = (expected: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, String(error));
  assert.equal(error.kind, expected);
  if (status) assert.equal(error.status, status);
  assert.ok(!error.message.includes("body"), "provider bodies must not reach the message");
  return true;
};

test("codesandbox filters labels exactly across pages and hides snapshots", async () => {
  const { requests, fetch } = fakeApi();
  const provider = codesandbox({ apiKey: "csb_test", baseUrl: "https://api.test", fetch });
  const listed = await provider.list({ labels: { team: "x" } });
  assert.deepEqual(listed.map(found => [found.id, found.state]), [["a", "running"], ["c", "stopped"]]);
  assert.deepEqual(listed[1]!.labels, { team: "x", other: "1" }, "undecodable tags are skipped");
  assert.ok(requests.some(request => request.startsWith("GET /sandbox?") && request.includes("tags=team%3Dx")));
  assert.equal((await provider.list()).length, 3);
  assert.deepEqual((await provider.get("p"))?.labels, { k: "v=w" });
});

test("codesandbox maps HTTP failures and honours abort", async () => {
  const { fetch } = fakeApi();
  const provider = codesandbox({ apiKey: "csb_test", baseUrl: "https://api.test", fetch });
  assert.equal(await provider.get("gone"), null);
  await provider.destroy("gone"); // already gone is not an error
  await assert.rejects(provider.pause("busy"), error => kind("unavailable", 429)(error) && (error as SandboxError).retryAfter === 7);
  await assert.rejects(provider.destroy("s1"), kind("rejected", 401));
  await assert.rejects(provider.destroy("down"), kind("unavailable"));
  await assert.rejects(provider.pause("s1", { signal: AbortSignal.abort(new Error("stop")) }), /stop/);
  await assert.rejects(provider.create({ labels: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "v"])) }), kind("rejected"));
});

/** A session whose commands write the given output files and exit with the given result. */
function fakeSession(result: () => Promise<string>) {
  const files = new Map<string, Uint8Array>();
  const scripts: string[] = [];
  let disposed = 0, killed = 0;
  const session: CsbSession = {
    state: "CONNECTED",
    commands: {
      async runBackground(script) {
        scripts.push(script);
        const dir = /\/tmp\/open-sb-exec-[\w-]+/.exec(script)?.[0];
        if (dir) { files.set(`${dir}/out`, new TextEncoder().encode("out\n")); files.set(`${dir}/err`, new TextEncoder().encode("err")); }
        return { waitUntilComplete: result, kill: async () => { killed++; } };
      },
      async run(script) { scripts.push(script); return ""; },
    },
    fs: {
      async readFile(path) { const data = files.get(path); if (!data) throw new Error("-2: ENOENT body with secret"); return data; },
      async writeFile(path, content) { files.set(path, content); },
      async mkdir() {},
      async remove() {},
    },
    dispose() { disposed++; },
  };
  const client = { sandboxes: { resume: async () => ({ connect: async () => session }) }, hosts: {} } as unknown as CsbClient;
  return { client, scripts, files, disposed: () => disposed, killed: () => killed };
}

const exitWith = (exitCode: number) => async () => {
  throw Object.assign(new Error(`Command failed with exit code ${exitCode}`), { name: "CommandError", exitCode, output: "merged" });
};

test("codesandbox exec separates output, reports exit codes and times out", async () => {
  const fake = fakeSession(exitWith(3));
  const provider = codesandbox({ client: fake.client, sessionIdleMs: 5 });
  assert.deepEqual(await provider.exec("s1", "exit 3", { env: { GREETING: "it's ok" }, cwd: "/tmp/a b" }),
    { exitCode: 3, stdout: "out\n", stderr: "err" });
  assert.match(fake.scripts[0]!, /cd '\/tmp\/a b' && export GREETING='it'\\''s ok' && exec bash -c 'exit 3'/);
  await assert.rejects(provider.readFile("s1", "/missing"), kind("not_found"));
  await provider.writeFile("s1", "/tmp/x/bin", new Uint8Array([0, 255]));
  assert.deepEqual(await provider.readFile("s1", "/tmp/x/bin"), new Uint8Array([0, 255]));
  await new Promise(done => setTimeout(done, 20));
  assert.equal(fake.disposed(), 1, "an idle session is closed so the process can exit");

  const slow = fakeSession(() => new Promise(() => {}));
  const stuck = codesandbox({ client: slow.client, sessionIdleMs: 5 });
  await assert.rejects(stuck.exec("s1", "sleep 999", { timeoutMs: 10 }), kind("timeout"));
  assert.equal(slow.killed(), 1, "a command past its timeout is killed");
  await new Promise(done => setTimeout(done, 20));
});

test("codesandbox port URLs carry a host token only for private ports", async () => {
  assert.deepEqual(await codesandbox({ client: {} as CsbClient }).portUrl("abc", 8080), { url: "https://abc-8080.csb.app" });
  const client = { hosts: { createToken: async () => ({ token: "tok" }) } } as unknown as CsbClient;
  assert.deepEqual(await codesandbox({ client, privatePorts: true }).portUrl("abc", 8080),
    { url: "https://abc-8080.csb.app", headers: { "csb-preview-token": "tok" } });
});
