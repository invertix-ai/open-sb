// The shared test suite every provider must pass. It runs against real sandboxes and checks the core plus
// every capability the provider declares, so a provider cannot claim a capability it does not have.
// Use it from a test file run by `node --test`:  conformance(boat({ apiKey }))
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { checkProvider } from "./config.ts";
import type { AnyProvider, Capability, SandboxInfo, SandboxState } from "./types.ts";

export interface ConformanceOptions {
  /** Image for the test sandbox. Default: the provider's default image. */
  image?: string;
  /** How long a state change (start, pause, resume) may take. Default 5 minutes. */
  waitMs?: number;
  /** A port on which `python3 -m http.server` can listen, for the `ports` test. Default 8765. */
  port?: number;
  /** Only test these capabilities (the core always runs). */
  only?: readonly Capability[];
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function waitFor(provider: AnyProvider, id: string, state: SandboxState, waitMs: number): Promise<SandboxInfo> {
  const until = Date.now() + waitMs;
  for (;;) {
    const info = await provider.get(id);
    if (info?.state === state) return info;
    if (Date.now() > until) assert.fail(`${provider.name}: sandbox ${id} did not become ${state} (last: ${info?.state ?? "missing"})`);
    await sleep(1_000);
  }
}

async function until<T>(what: string, waitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

/** An OpenSSH `ssh-ed25519` public key line, built without any SSH library. */
function sshPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")} sandbox-kit-conformance`;
}

/** Registers the conformance tests for one provider with `node:test`. */
export function conformance(provider: AnyProvider, options: ConformanceOptions = {}): void {
  const waitMs = options.waitMs ?? 300_000;
  const declared = new Set(provider.capabilities);
  const run = (capability: Capability) => declared.has(capability) && (!options.only || options.only.includes(capability));
  const labels = { "sandbox-kit.conformance": randomUUID() };
  const created: string[] = [];
  let id = "";
  /** Methods of declared capabilities, reached without casts at every call site. */
  const call = provider as AnyProvider & Record<string, (...args: never[]) => Promise<unknown>>;
  const method = <T>(name: string) => call[name] as unknown as T;

  describe(`sandbox-kit conformance: ${provider.name}`, { timeout: waitMs * 6 }, () => {
    before(async () => {
      const report = checkProvider(provider, []);
      assert.deepEqual(report.broken, [], `${provider.name} declares capabilities it does not implement`);
      const sandbox = await provider.create({ image: options.image, labels, idempotencyKey: randomUUID() });
      id = sandbox.id;
      created.push(id);
      await waitFor(provider, id, "running", waitMs);
    });

    after(async () => {
      for (const sandbox of created) await provider.destroy(sandbox).catch(() => undefined);
    });

    test("get and list find the sandbox by its labels", async () => {
      const info = await provider.get(id);
      assert.equal(info?.id, id);
      assert.equal(info?.labels["sandbox-kit.conformance"], labels["sandbox-kit.conformance"]);
      const listed = await provider.list({ labels });
      assert.ok(listed.some(sandbox => sandbox.id === id), "list({ labels }) must include the sandbox");
      assert.ok(listed.every(sandbox => sandbox.labels["sandbox-kit.conformance"] === labels["sandbox-kit.conformance"]),
        "list({ labels }) must only return matching sandboxes");
    });

    test("exec returns output, exit code, environment and working directory", async () => {
      const hello = await provider.exec(id, "echo hello; echo oops >&2");
      assert.equal(hello.exitCode, 0);
      assert.equal(hello.stdout.trim(), "hello");
      assert.equal((await provider.exec(id, "exit 3")).exitCode, 3);
      assert.equal((await provider.exec(id, 'printf %s "$GREETING"', { env: { GREETING: "it's ok" } })).stdout, "it's ok");
      await provider.exec(id, "mkdir -p /tmp/sandbox-kit-cwd");
      assert.equal((await provider.exec(id, "pwd", { cwd: "/tmp/sandbox-kit-cwd" })).stdout.trim().endsWith("/tmp/sandbox-kit-cwd"), true);
    });

    test("files round-trip, including binary data", async () => {
      const bytes = new Uint8Array(256).map((_, index) => index);
      await provider.writeFile(id, "/tmp/sandbox-kit/binary.bin", bytes);
      assert.deepEqual(await provider.readFile(id, "/tmp/sandbox-kit/binary.bin"), bytes);
      await provider.writeFile(id, "/tmp/sandbox-kit/text.txt", "héllo\n");
      assert.equal(Buffer.from(await provider.readFile(id, "/tmp/sandbox-kit/text.txt")).toString(), "héllo\n");
      assert.equal((await provider.exec(id, "cat /tmp/sandbox-kit/text.txt")).stdout, "héllo\n", "files written must be visible to exec");
    });

    test("background processes keep running after the call returns", { skip: !run("background") }, async () => {
      await method<(id: string, command: string) => Promise<void>>("startBackground")(id, "sleep 2; echo done > /tmp/sandbox-kit-background");
      await until("the background process", 60_000, async () => {
        const result = await provider.exec(id, "cat /tmp/sandbox-kit-background");
        return result.exitCode === 0 && result.stdout.trim() === "done" ? true : undefined;
      });
    });

    test("ports are reachable over HTTPS", { skip: !run("ports") }, async () => {
      const port = options.port ?? 8765;
      const portUrl = method<(id: string, port: number) => Promise<{ url: string; headers?: Record<string, string> }>>("portUrl");
      if (declared.has("background")) {
        await provider.writeFile(id, "/tmp/sandbox-kit-www/index.html", "sandbox-kit");
        await method<(id: string, command: string, options: { cwd: string }) => Promise<void>>("startBackground")(
          id, `python3 -m http.server ${port} --bind 0.0.0.0`, { cwd: "/tmp/sandbox-kit-www" });
      }
      const { url, headers } = await portUrl(id, port);
      assert.equal(new URL(url).protocol, "https:");
      if (declared.has("background"))
        await until("the port to serve", 120_000, async () => {
          const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
          return response.ok && (await response.text()).includes("sandbox-kit") ? true : undefined;
        });
    });

    test("ssh returns a reachable endpoint", { skip: !run("ssh") }, async () => {
      const access = await method<(id: string, key: string) => Promise<{ host: string; port: number; user: string }>>("ssh")(id, sshPublicKey());
      assert.ok(access.host && access.user && Number.isInteger(access.port));
      await new Promise<void>((done, fail) => {
        const socket = net.connect({ host: access.host, port: access.port, timeout: 20_000 }, () => { socket.destroy(); done(); });
        socket.once("error", fail);
        socket.once("timeout", () => { socket.destroy(); fail(new Error("SSH port did not answer")); });
      });
    });

    test("desktop returns a viewer URL", { skip: !run("desktop") }, async () => {
      const desktop = method<(id: string) => Promise<{ url: string } | { provisioning: true }>>("desktop");
      const viewer = await until("the desktop", waitMs, async () => {
        const result = await desktop(id);
        return "url" in result ? result.url : undefined;
      });
      assert.equal(new URL(viewer).protocol, "https:");
    });

    test("ttl sets when the sandbox stops on its own", { skip: !run("ttl") }, async () => {
      await method<(id: string, seconds: number) => Promise<void>>("setTtl")(id, 1_800);
      const info = await provider.get(id);
      assert.ok(info?.expiresAt, "get() must report expiresAt after setTtl");
      const seconds = (info.expiresAt.getTime() - Date.now()) / 1000;
      assert.ok(seconds > 1_500 && seconds < 2_100, `expiresAt should be about 30 minutes away, got ${Math.round(seconds)} s`);
    });

    test("snapshots create new sandboxes with the saved files", { skip: !run("snapshot") }, async () => {
      const name = `sandbox-kit-${randomUUID().slice(0, 8)}`;
      await provider.writeFile(id, "/tmp/sandbox-kit/snapshot.txt", name);
      await method<(id: string, name: string) => Promise<void>>("snapshot")(id, name);
      try {
        assert.ok((await method<() => Promise<string[]>>("listSnapshots")()).includes(name));
        const copy = await provider.create({ image: name, labels });
        created.push(copy.id);
        await waitFor(provider, copy.id, "running", waitMs);
        assert.equal(Buffer.from(await provider.readFile(copy.id, "/tmp/sandbox-kit/snapshot.txt")).toString(), name);
        await provider.destroy(copy.id);
      } finally {
        await method<(name: string) => Promise<void>>("deleteSnapshot")(name);
      }
      assert.ok(!(await method<() => Promise<string[]>>("listSnapshots")()).includes(name));
    });

    test("pause and resume", { skip: !run("pause") }, async () => {
      // Under $HOME rather than /tmp: some providers clear /tmp on boot.
      if (declared.has("persistentDisk")) await provider.exec(id, 'printf kept > "$HOME/sandbox-kit-persist.txt"');
      await method<(id: string) => Promise<void>>("pause")(id);
      await waitFor(provider, id, "stopped", waitMs);
      await method<(id: string) => Promise<void>>("resume")(id);
      await waitFor(provider, id, "running", waitMs);
      await until("exec after resume", waitMs, async () => (await provider.exec(id, "true")).exitCode === 0 ? true : undefined);
      if (run("persistentDisk"))
        assert.equal((await provider.exec(id, 'cat "$HOME/sandbox-kit-persist.txt"')).stdout, "kept", "files must survive pause and resume");
    });

    test("destroy removes the sandbox", async () => {
      await provider.destroy(id);
      const info = await until("the sandbox to go away", waitMs, async () => {
        const current = await provider.get(id);
        return current === null || current.state === "gone" ? (current ?? "deleted") : undefined;
      });
      assert.ok(info);
      await provider.destroy(id); // destroying twice is not an error
    });
  });
}
