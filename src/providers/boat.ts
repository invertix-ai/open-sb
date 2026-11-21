// Boat (boat.dev): full VMs with sleep/wake that keeps the disk, named snapshots, private port URLs, SSH and
// a VNC desktop. Uses the official `@boatdev/sdk` (a peer dependency).
import { BoatApi, Configuration, FetchError, ResponseError, type Sandbox } from "@boatdev/sdk";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { ExecOptions, SandboxInfo, SandboxState } from "../types.ts";

export interface BoatOptions {
  apiKey?: string;
  /** A configured client; replaces `apiKey`. */
  client?: BoatApi;
  /** Lifetime given to new and resumed sandboxes. Default 900 s; extend with `setTtl`. */
  ttlSeconds?: number;
  name?: string;
  /** Override for tests: used to exchange a port URL's token for its cookie. */
  fetch?: typeof fetch;
}

const STATES: Record<string, SandboxState> = {
  init: "starting", provisioning: "starting", provisioned: "starting", cloning: "starting",
  ready: "running", idle: "running", running: "running",
  archiving: "stopped", archived: "stopped", stopped: "stopped",
  error: "gone", cancelled: "gone", failed: "gone", deleted: "gone",
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const withEnv = (command: string, env?: Record<string, string>) => {
  const entries = Object.entries(env ?? {});
  for (const [key] of entries) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  return entries.length ? `${entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("; ")}; ${command}` : command;
};

export function boat(options: BoatOptions = {}) {
  const name = options.name ?? "boat";
  const ttlSeconds = options.ttlSeconds ?? 900;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let api = options.client;
  const client = () => api ??= new BoatApi(new Configuration({
    basePath: "https://boat.dev/api/v1",
    accessToken: options.apiKey ?? (() => { throw new SandboxError("rejected", name, { code: "missing_api_key" }); })(),
  }));

  /** Maps SDK failures onto SandboxError; provider bodies never reach the message. */
  async function call<T>(work: (boat: BoatApi, init: RequestInit) => Promise<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await work(client(), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof ResponseError) {
        const body = await error.response.json().catch(() => ({})) as { code?: unknown; retryAfter?: unknown; retryAfterSeconds?: unknown };
        const retry = typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : typeof body.retryAfter === "number" ? body.retryAfter : undefined;
        throw httpError(name, error.response.status, typeof body.code === "string" ? body.code : undefined, retry);
      }
      if (timeout.aborted) throw new SandboxError("timeout", name, { code: "request_timeout" });
      if (error instanceof FetchError || error instanceof TypeError) throw httpError(name, null, "network");
      throw error;
    }
  }

  const info = (sandbox: Sandbox): SandboxInfo => ({
    id: sandbox.id,
    state: STATES[String(sandbox.state)] ?? "starting",
    labels: { ...(sandbox.labels ?? {}) } as Record<string, string>,
    createdAt: sandbox.createdAt ?? undefined,
    expiresAt: sandbox.archiveAfter ?? undefined,
  });

  async function exec(id: string, command: string, execOptions: ExecOptions = {}, detached = false) {
    const timeoutSeconds = Math.max(1, Math.ceil((execOptions.timeoutMs ?? 600_000) / 1000));
    const result = await call((b, init) => b.command({ sandboxId: id, commandRequest: {
      command: withEnv(command, execOptions.env), cwd: execOptions.cwd, timeoutSeconds, detached } }, init),
    execOptions.signal, timeoutSeconds * 1000 + 15_000);
    return result as { exitCode?: number | null; timedOut?: boolean; stdout?: string; stderr?: string };
  }

  return defineProvider({
    name,
    capabilities: ["pause", "snapshot", "ttl", "ports", "ssh", "desktop", "background", "persistentDisk"] as const,

    async create(createOptions = {}) {
      const created = await call((b, init) => b.create({ idempotencyKey: createOptions.idempotencyKey, createSandboxRequest: {
        ttlSeconds, noEnv: true, labels: createOptions.labels, ...(createOptions.image ? { from: createOptions.image } : {}) } }, init), createOptions.signal);
      return info(created.sandbox);
    },

    async get(id, callOptions = {}) {
      try {
        return info((await call((b, init) => b.get({ sandboxId: id }, init), callOptions.signal)).sandbox);
      } catch (error) {
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    async list(filter = {}) {
      const label = Object.entries(filter.labels ?? {}).map(([key, value]) => `${key}=${value}`);
      const found: SandboxInfo[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await call((b, init) => b.sandboxes({ ...(label.length ? { label } : {}), cursor, limit: 100 }, init), filter.signal);
        found.push(...page.sandboxes.map(info));
        cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor : null;
      } while (cursor);
      return found;
    },

    async destroy(id, callOptions = {}) {
      try {
        await call((b, init) => b.deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id }, init), callOptions.signal);
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    async exec(id, command, execOptions = {}) {
      const result = await exec(id, command, execOptions);
      if (result.timedOut) throw new SandboxError("timeout", name, { code: "exec_timeout" });
      return { exitCode: result.exitCode ?? 128, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },

    async readFile(id, path, callOptions = {}) {
      const file = await call((b, init) => b.readFile({ sandboxId: id, path, encoding: "base64" }, init), callOptions.signal);
      return new Uint8Array(Buffer.from(file.content, "base64"));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      await call(async (b, init) => {
        // The JSON endpoint takes at most 5 MiB; larger files use a signed upload URL.
        if (bytes.length <= 5 * 1024 * 1024) {
          await b.writeFile({ sandboxId: id, fileWriteRequest: { path, content: bytes.toString("base64"), encoding: "base64" } }, init);
          return;
        }
        const upload = await b.createUploadUrl({ sandboxId: id, fileUrlRequest: { path } }, init);
        // The signed URL is a credential: never send the API key with it and never follow redirects.
        const response = await fetch(upload.url, { method: "PUT", body: new Uint8Array(bytes), redirect: "error", signal: init.signal,
          headers: { "content-type": "application/octet-stream" } });
        await response.body?.cancel();
        if (!response.ok) throw new ResponseError(response);
      }, callOptions.signal, 300_000);
    },

    async pause(id, callOptions = {}) {
      await call((b, init) => b.stop({ sandboxId: id }, init), callOptions.signal);
    },

    async resume(id, callOptions = {}) {
      await call((b, init) => b.resume({ sandboxId: id, resumeRequest: { ttlSeconds } }, init), callOptions.signal);
    },

    async snapshot(id, snapshot, callOptions = {}) {
      await call((b, init) => b.saveNamedSnapshot({ namedSnapshotSaveRequest: { sandboxId: id, name: snapshot } }, init), callOptions.signal);
    },

    async listSnapshots(callOptions = {}) {
      return (await call((b, init) => b.listNamedSnapshots(init), callOptions.signal)).snapshots.map(snapshot => snapshot.name);
    },

    async deleteSnapshot(snapshot, callOptions = {}) {
      await call((b, init) => b.deleteNamedSnapshot({ name: snapshot }, init), callOptions.signal);
    },

    async setTtl(id, seconds, callOptions = {}) {
      await call((b, init) => b.update({ sandboxId: id, updateSandboxRequest: { ttlSeconds: seconds } }, init), callOptions.signal);
    },

    /**
     * A private URL. Boat swaps its `_token` query for a `_port_auth` cookie on the first request (a 302), which
     * WebSockets and fetch cannot keep, so the cookie comes back as a header and the URL loses the token.
     * Localhost relay first (services bound to 127.0.0.1); a service on 0.0.0.0 makes Boat refuse it, so then direct.
     */
    async portUrl(id, port, callOptions = {}) {
      const host = (localhost: boolean) => call((b, init) => b.hostPort({ sandboxId: id, hostPortRequest: { port, localhost } }, init), callOptions.signal);
      const result = await host(true).catch(error => {
        if (error instanceof SandboxError && error.code === "localhost_relay_failed") return host(false);
        throw error;
      });
      if (!result.url || result.isProtected === false || result.access === "public")
        throw new SandboxError("rejected", name, { code: "port_not_private" });
      const url = new URL(result.url);
      if (!url.searchParams.has("_token")) return { url: result.url };
      let response: Response;
      try {
        response = await fetchImpl(url, { redirect: "manual", signal: callOptions.signal ? AbortSignal.any([callOptions.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      } catch {
        throw httpError(name, null, "network");
      }
      await response.body?.cancel();
      const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).filter(value => value.startsWith("_port_auth=")).join("; ");
      if (!cookie) return { url: result.url };
      url.searchParams.delete("_token");
      return { url: url.href, headers: { cookie } };
    },

    async ssh(id, publicKey, callOptions = {}) {
      const access = await call((b, init) => b.sshKey({ sandboxId: id, sshKeyRequest: { key: publicKey } }, init), callOptions.signal);
      let host = access.machineIp ?? "", port = 22;
      if (access.sshEndpoint) {
        const split = access.sshEndpoint.lastIndexOf(":");
        host = access.sshEndpoint.slice(0, split).replace(/^\[(.*)\]$/, "$1");
        port = Number(access.sshEndpoint.slice(split + 1));
      }
      if (!host || !Number.isInteger(port)) throw new SandboxError("unavailable", name, { code: "ssh_endpoint_missing" });
      return { host, port, user: access.sshUser || "user", hostKey: access.hostKey };
    },

    async desktop(id, callOptions = {}) {
      const result = await call((b, init) => b.desktop({ sandboxId: id, vnc: 1, desktopRequest: { publicAccess: false } }, init), callOptions.signal);
      if (result.desktopUrl) return { url: result.desktopUrl };
      if (result.provisioning) return { provisioning: true as const };
      throw new SandboxError("unavailable", name, { code: "desktop_unavailable" });
    },

    async startBackground(id, command, execOptions = {}) {
      const result = await exec(id, command, execOptions, true);
      if (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0)
        throw new SandboxError("rejected", name, { code: "background_start_failed" });
    },
  });
}
