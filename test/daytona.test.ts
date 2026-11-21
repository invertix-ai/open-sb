// Daytona labels, states, exec and error mapping, through a substituted client (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaytonaConflictError, DaytonaNotFoundError, DaytonaRateLimitError, DaytonaServiceUnavailableError } from "@daytonaio/sdk";
import { SandboxError } from "../src/errors.ts";
import { daytona, type DaytonaClient, type DaytonaSandbox } from "../src/providers/daytona.ts";

test("daytona maps labels, states, exec results and failures", async () => {
  const commands: string[] = [];
  const ttls: number[] = [];
  const sessions = new Set<string>();
  const sandboxes = new Map<string, DaytonaSandbox>();
  const fake = (id: string, state: string, labels: Record<string, string>, sandboxName = id): DaytonaSandbox => {
    const sandbox: DaytonaSandbox = {
      id, state, labels, createdAt: "2026-11-20T10:00:00Z",
      async start() { sandbox.state = "started"; },
      async stop() { sandbox.state = "stopped"; },
      async delete() { sandbox.state = "destroyed"; },
      async createSnapshot() {},
      async setTtl(minutes) { sandbox.autoDestroyAt = new Date(Date.now() + minutes * 60_000).toISOString(); ttls.push(minutes); },
      async getPreviewLink(port) { return { url: `https://${port}-${id}.proxy.daytona.works`, token: "preview-token" }; },
      fs: { async createFolder() {}, async uploadFile() {}, async downloadFile() { return Buffer.from("x"); } },
      process: {
        async createSession(session) { sessions.add(session); },
        async executeSessionCommand(_session, request) {
          commands.push(request.command);
          return request.command.includes("exit 3") ? { exitCode: 3, stdout: "", stderr: "" } : { exitCode: 0, stdout: "hello\n", stderr: "oops\n" };
        },
        async deleteSession(session) { sessions.delete(session); },
      },
    };
    sandboxes.set(sandboxName, sandbox);
    return sandbox;
  };
  fake("a", "started", { team: "a", extra: "1" });
  fake("b", "archived", { team: "a" });
  fake("c", "creating", { team: "b" });
  fake("d", "destroyed", { team: "a" });
  const client: DaytonaClient = {
    async create(params = {}) {
      if (params.name && sandboxes.has(params.name)) throw new DaytonaConflictError("name taken", 409);
      return fake(`new-${sandboxes.size}`, "started", params.labels ?? {}, params.name);
    },
    async get(id) {
      if (id === "busy") throw new DaytonaServiceUnavailableError("down", 503);
      if (id === "limited") throw new DaytonaRateLimitError("slow down", 429, new Map([["retry-after", "7"]]) as never);
      const sandbox = sandboxes.get(id);
      if (!sandbox) throw new DaytonaNotFoundError("no such sandbox: secret detail", 404);
      return sandbox;
    },
    // Ignores the label filter on purpose: the provider must filter exactly on its own.
    async *list() { yield* new Set(sandboxes.values()); },
    snapshot: {
      async list({ page = 1 } = {}) {
        return page === 1 ? { items: [{ name: "mine", state: "active", general: false }, { name: "daytona-default", state: "active", general: true }], totalPages: 2 }
          : { items: [{ name: "mine-2", state: "active", general: false }], totalPages: 2 };
      },
      async get(name) { return { name, state: "active" }; },
      async delete(name) { if (name === "missing") throw new DaytonaNotFoundError("missing", 404); },
    },
  };
  const provider = daytona({ client });

  const listed = await provider.list({ labels: { team: "a" } });
  assert.deepEqual(listed.map(sandbox => [sandbox.id, sandbox.state]), [["a", "running"], ["b", "stopped"], ["d", "gone"]]);
  assert.equal((await provider.get("c"))?.state, "starting");
  assert.equal((await provider.get("a"))?.createdAt?.toISOString(), "2026-11-20T10:00:00.000Z");

  assert.equal(await provider.get("gone"), null);
  await assert.rejects(provider.get("busy"), (error: unknown) => error instanceof SandboxError && error.kind === "unavailable" && error.status === 503);
  await assert.rejects(provider.get("limited"), (error: unknown) => error instanceof SandboxError && error.kind === "unavailable" && error.retryAfter === 7);
  await assert.rejects(provider.exec("gone", "true"), (error: unknown) =>
    error instanceof SandboxError && error.kind === "not_found" && !error.message.includes("secret detail"));

  const hello = await provider.exec("a", "echo hello; echo oops >&2", { cwd: "/tmp/it's", env: { GREETING: "it's ok" } });
  assert.deepEqual(hello, { exitCode: 0, stdout: "hello\n", stderr: "oops\n" });
  assert.equal(commands.at(-1), `sh -c 'export GREETING='\\''it'\\''\\'\\'''\\''s ok'\\'' && cd '\\''/tmp/it'\\''\\'\\'''\\''s'\\'' && echo hello; echo oops >&2'`);
  assert.equal((await provider.exec("a", "exit 3")).exitCode, 3, "a nonzero exit is a result, not an error");
  assert.equal(sessions.size, 0, "exec sessions are deleted");

  const first = await provider.create({ labels: { team: "z" }, idempotencyKey: "key-1" });
  const again = await provider.create({ labels: { team: "z" }, idempotencyKey: "key-1" });
  assert.equal(again.id, first.id, "the same idempotency key returns the same sandbox");
  assert.equal(first.labels["open-sb.idempotency-key"], "key-1");

  assert.deepEqual(await provider.portUrl("a", 8080),
    { url: "https://8080-a.proxy.daytona.works", headers: { "X-Daytona-Preview-Token": "preview-token" } });
  assert.deepEqual(await provider.listSnapshots(), ["mine", "mine-2"]);
  await provider.deleteSnapshot("missing");

  assert.equal((await provider.get("a"))?.expiresAt, undefined);
  await provider.setTtl("a", 1_801);
  assert.deepEqual(ttls, [31], "seconds round up to whole minutes");
  const left = ((await provider.get("a"))!.expiresAt!.getTime() - Date.now()) / 1000;
  assert.ok(left > 1_800 && left <= 1_860, "get() reports Daytona's autoDestroyAt as expiresAt");

  await provider.pause("a");
  assert.equal((await provider.get("a"))?.state, "stopped");
  await provider.resume("a");
  await provider.destroy("a");
  await provider.destroy("a");
  await provider.destroy("never-existed");
  assert.equal((await provider.get("a"))?.state, "gone");

  const controller = new AbortController();
  controller.abort(new Error("caller gave up"));
  await assert.rejects(provider.get("a", { signal: controller.signal }), /caller gave up/);
});
