// Modal label filtering, exec results and error mapping, through a fake SDK client (no account needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotFoundError, SandboxFilesystemNotFoundError, type ModalClient } from "modal";
import { SandboxError } from "../src/errors.ts";
import { modal } from "../src/providers/modal.ts";

const text = (value: string) => ({ readText: async () => value });
/** A gRPC failure as nice-grpc raises it, with a body that must not reach the error message. */
const grpc = (code: number) => Object.assign(new Error("secret server detail"), { name: "ClientError", code });

test("modal maps labels, exec, ports, snapshots and failures", async () => {
  const boxes: Record<string, { tags: Record<string, string>; exit: number | null }> = {
    a: { tags: { team: "a" }, exit: null }, b: { tags: { team: "b" }, exit: null },
  };
  const created: { tags?: Record<string, string>; encryptedPorts?: number[] }[] = [];
  const execs: { argv: string[]; params: { workdir?: string; env?: Record<string, string>; timeoutMs?: number } }[] = [];
  const sandbox = (id: string) => ({
    sandboxId: id,
    poll: async () => { if (id === "outage") throw grpc(14); if (!boxes[id]) throw grpc(5); return boxes[id].exit; },
    getTags: async () => ({ ...boxes[id]?.tags }),
    terminate: async () => { if (!boxes[id]) throw grpc(5); boxes[id].exit = 137; },
    exec: async (argv: string[], params: (typeof execs)[number]["params"]) => {
      execs.push({ argv, params });
      return { stdout: text("out"), stderr: text("err"), wait: async () => (argv[2] === "exit 3" ? 3 : 0) };
    },
    filesystem: { readBytes: async (path: string) => { throw new SandboxFilesystemNotFoundError(`no ${path}`); } },
    createConnectToken: async ({ port }: { port: number }) => ({ url: `https://${id}-${port}.modal.test`, token: "tok" }),
  });
  const client = {
    environmentName: () => "main",
    apps: { fromName: async () => ({ appId: "ap-1" }) },
    images: {
      fromRegistry: (tag: string) => ({ imageId: "", tag }),
      fromName: async (ref: string) => { throw new NotFoundError(ref); },
    },
    sandboxes: {
      fromId: async (id: string) => sandbox(id),
      // Modal filters by tags on the server; the fake does the same.
      list: async function* ({ tags }: { tags?: Record<string, string> }) {
        for (const [id, box] of Object.entries(boxes))
          if (box.exit === null && Object.entries(tags ?? {}).every(([key, value]) => box.tags[key] === value)) yield sandbox(id);
      },
      create: async (_app: unknown, _image: unknown, params: (typeof created)[number]) => {
        created.push(params);
        boxes.c = { tags: params.tags ?? {}, exit: null };
        return sandbox("c");
      },
    },
    cpClient: {
      imageListTags: async () => ({ items: [{ tag: "open-sb-snapshots:one" }, { tag: "open-sb-snapshots:two" }], nextPageToken: "" }),
    },
  } as unknown as ModalClient;
  const provider = modal({ client, encryptedPorts: [8000] });

  assert.deepEqual((await provider.list({ labels: { team: "a" } })).map(sandbox => [sandbox.id, sandbox.state, sandbox.labels]),
    [["a", "running", { team: "a" }]]);

  const first = await provider.create({ labels: { team: "c" }, idempotencyKey: "k1" });
  assert.deepEqual(created[0]!.tags, { team: "c", "open-sb.idempotency-key": "k1" });
  assert.deepEqual(created[0]!.encryptedPorts, [8000]);
  assert.equal((await provider.create({ idempotencyKey: "k1" })).id, first.id, "a retried create returns the same sandbox");
  assert.equal(created.length, 1);

  const result = await provider.exec("a", "exit 3", { cwd: "/tmp", env: { Q: `it's "x"` }, timeoutMs: 1_500 });
  assert.deepEqual(result, { exitCode: 3, stdout: "out", stderr: "err" });
  assert.deepEqual(execs[0], { argv: ["sh", "-c", "exit 3"], params: { workdir: "/tmp", env: { Q: `it's "x"` }, timeoutMs: 2_000 } });

  assert.deepEqual(await provider.portUrl("a", 3000), { url: "https://a-3000.modal.test", headers: { Authorization: "Bearer tok" } });
  assert.deepEqual(await provider.listSnapshots(), ["one", "two"]);

  assert.equal(await provider.get("missing"), null);
  await provider.destroy("missing"); // not an error
  await provider.destroy("a");
  assert.equal((await provider.get("a"))?.state, "gone");
  await assert.rejects(provider.get("outage"), (error: unknown) =>
    error instanceof SandboxError && error.kind === "unavailable" && error.code === "UNAVAILABLE" && !error.message.includes("secret"));
  await assert.rejects(provider.readFile("b", "/nope"), (error: unknown) => error instanceof SandboxError && error.kind === "not_found");
  await provider.deleteSnapshot("never-made"); // already gone is not an error
});
