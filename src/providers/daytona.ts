// Daytona (daytona.io): containers started from snapshots, with stop/start that keeps the disk, named snapshots
// taken from a running sandbox, and private preview URLs for ports. Uses the official `@daytonaio/sdk` (a peer
// dependency). On Daytona, `ttl` expiry DELETES the sandbox and its disk (Daytona's wall-clock TTL, counted even
// while stopped), it does not stop it; `expiresAt` is Daytona's `autoDestroyAt`. Limits: no SSH with a caller's
// key (Daytona hands out its own access tokens instead). Desktop access starts Computer Use and signs the
// noVNC port; default snapshots include the desktop stack, custom images must install it. The SDK takes no AbortSignal:
// an abort or timeout stops waiting, while the request itself runs to completion at Daytona.
import { createHash, randomUUID } from "node:crypto";
import {
  Daytona, DaytonaConflictError, DaytonaConnectionError, DaytonaError, DaytonaInvalidArgumentError,
  DaytonaQueueTimeoutError, DaytonaTimeoutError,
  type CreateSandboxFromImageParams, type CreateSandboxFromSnapshotParams,
} from "@daytonaio/sdk";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, SandboxInfo, SandboxState } from "../types.ts";

/** The parts of a Daytona sandbox this provider uses; the SDK's `Sandbox` satisfies it. */
export interface DaytonaSandbox {
  id: string;
  state?: string;
  labels: Record<string, string>;
  createdAt?: string;
  /** When Daytona's TTL deletes the sandbox. */
  autoDestroyAt?: string;
  start(timeout?: number): Promise<void>;
  stop(timeout?: number): Promise<void>;
  delete(timeout?: number): Promise<void>;
  createSnapshot(name: string, timeout?: number): Promise<void>;
  setTtl(ttlMinutes: number): Promise<void>;
  getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<{ url: string }>;
  computerUse: {
    start(): Promise<unknown>;
  };
  fs: {
    createFolder(path: string, mode: string): Promise<void>;
    uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
    downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  };
  process: {
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(sessionId: string, request: { command: string; runAsync?: boolean }, timeout?: number):
      Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
    deleteSession(sessionId: string): Promise<void>;
  };
}

/** The parts of the Daytona client this provider uses; `new Daytona()` satisfies it, and tests pass a fake. */
export interface DaytonaClient {
  create(params?: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams, options?: { timeout?: number }): Promise<DaytonaSandbox>;
  get(sandboxIdOrName: string): Promise<DaytonaSandbox>;
  list(query?: { labels?: Record<string, string>; limit?: number }): AsyncIterable<DaytonaSandbox>;
  snapshot: {
    list(query?: { page?: number; limit?: number }): Promise<{ items: { name: string; state: string; general: boolean }[]; totalPages: number }>;
    get(idOrName: string): Promise<{ name: string; state: string }>;
    delete(snapshot: string): Promise<void>;
  };
}

export interface DaytonaOptions {
  /** Default: the `DAYTONA_API_KEY` environment variable, as the SDK reads it. */
  apiKey?: string;
  /** Default `https://app.daytona.io/api`. */
  apiUrl?: string;
  /** Region, for example `us` or `eu`. Default: the organization's default region. */
  target?: string;
  /** Snapshot for new sandboxes when `create` names none. Default: Daytona's default snapshot. */
  snapshot?: string;
  /** Docker image for new sandboxes when neither `create` nor `snapshot` names a snapshot (Daytona builds it). */
  image?: string;
  /** Idle minutes before Daytona stops a sandbox on its own (0 disables). Default: Daytona's, 15 minutes. */
  autoStopInterval?: number;
  /** Lifetime of each desktop viewer credential, in seconds (60–86400). Default: 3600. */
  desktopExpiresInSeconds?: number;
  /** A configured client; replaces `apiKey`, `apiUrl` and `target`. */
  client?: DaytonaClient;
  name?: string;
}

const STATES: Record<string, SandboxState> = {
  creating: "starting", restoring: "starting", starting: "starting", resuming: "starting", pending_build: "starting",
  building_snapshot: "starting", pulling_snapshot: "starting", unknown: "starting",
  started: "running", resizing: "running", snapshotting: "running", forking: "running",
  stopping: "stopped", stopped: "stopped", pausing: "stopped", paused: "stopped", archiving: "stopped", archived: "stopped",
  destroying: "gone", destroyed: "gone", error: "gone", build_failed: "gone",
};
const IDEMPOTENCY_LABEL = "open-sb.idempotency-key";
/** Seconds Daytona may take to start, stop, restore or snapshot a sandbox. */
const SLOW = 300;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** The command as one `sh -c` script, so `exit` and `cd` stay inside it rather than ending the Daytona session. */
function script(command: string, options: ExecOptions) {
  const env = Object.entries(options.env ?? {});
  for (const [key] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  const prefix = [...env.map(([key, value]) => `export ${key}=${quote(value)}`), ...(options.cwd ? [`cd ${quote(options.cwd)}`] : [])];
  return `sh -c ${quote(prefix.length ? `${prefix.join(" && ")} && ${command}` : command)}`;
}

export function daytona(options: DaytonaOptions = {}) {
  const name = options.name ?? "daytona";
  const desktopTtl = options.desktopExpiresInSeconds ?? 3600;
  if (!Number.isInteger(desktopTtl) || desktopTtl < 60 || desktopTtl > 86400)
    throw new Error("desktopExpiresInSeconds must be an integer from 60 to 86400");
  let sdk = options.client;
  const client = () => sdk ??= new Daytona({ apiKey: options.apiKey, apiUrl: options.apiUrl, target: options.target }) satisfies DaytonaClient;

  /** Maps SDK failures onto SandboxError (messages never include Daytona's response) and honours abort and timeout. */
  async function call<T>(work: (daytona: DaytonaClient) => Promise<T>, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
    signal?.throwIfAborted();
    let stop = () => {};
    const stopped = new Promise<never>((_, fail) => {
      const timer = setTimeout(() => fail(new SandboxError("timeout", name, { code: "request_timeout" })), timeoutMs);
      const abort = () => fail(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    });
    try {
      return await Promise.race([Promise.resolve().then(() => work(client())), stopped]);
    } catch (error) {
      throw translate(error);
    } finally {
      stop();
    }
  }

  function translate(error: unknown): unknown {
    if (!(error instanceof DaytonaError)) return error;
    const code = error.code;
    if (error instanceof DaytonaQueueTimeoutError) return new SandboxError("unavailable", name, { code: "queue_timeout" });
    if (error.statusCode && error.statusCode !== 408) {
      const retry = Number(error.headers?.get?.("retry-after"));
      return httpError(name, error.statusCode, code, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    if (error instanceof DaytonaTimeoutError) return new SandboxError("timeout", name, { status: error.statusCode, code });
    if (error instanceof DaytonaConnectionError) return httpError(name, null, "network");
    if (error instanceof DaytonaInvalidArgumentError) return new SandboxError("rejected", name, { code: "invalid_argument" });
    // No HTTP status: the SDK gave up waiting on a state change, or a sandbox failed to start.
    return new SandboxError("unavailable", name, { code: code ?? "sdk_error" });
  }

  const info = (sandbox: DaytonaSandbox): SandboxInfo => ({
    id: sandbox.id,
    state: STATES[String(sandbox.state)] ?? "starting",
    labels: { ...sandbox.labels },
    createdAt: sandbox.createdAt ? new Date(sandbox.createdAt) : undefined,
    expiresAt: sandbox.autoDestroyAt ? new Date(sandbox.autoDestroyAt) : undefined,
  });

  const notFound = (error: unknown) => error instanceof SandboxError && error.kind === "not_found";

  async function list(filter: { labels?: Record<string, string> } & CallOptions = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    return call(async daytona => {
      const found: SandboxInfo[] = [];
      // The SDK follows Daytona's cursor across pages; the label filter is applied again here to keep it exact.
      for await (const sandbox of daytona.list({ ...(wanted.length ? { labels: filter.labels } : {}), limit: 100 })) {
        filter.signal?.throwIfAborted();
        if (wanted.every(([key, value]) => sandbox.labels?.[key] === value)) found.push(info(sandbox));
      }
      return found;
    }, filter.signal, 300_000);
  }

  /** One command in its own Daytona session, so separate stdout and stderr come back and no shell state leaks. */
  async function run(id: string, command: string, execOptions: ExecOptions = {}) {
    const full = script(command, execOptions);
    const seconds = Math.max(1, Math.ceil((execOptions.timeoutMs ?? 600_000) / 1000));
    const session = `open-sb-${randomUUID()}`;
    const sandbox = await call(daytona => daytona.get(id), execOptions.signal);
    await call(() => sandbox.process.createSession(session), execOptions.signal);
    try {
      return await call(() => sandbox.process.executeSessionCommand(session, { command: full }, seconds), execOptions.signal, seconds * 1000 + 15_000);
    } catch (error) {
      if (error instanceof SandboxError && error.kind === "timeout") throw new SandboxError("timeout", name, { code: "exec_timeout" });
      throw error;
    } finally {
      // Deleting the session also ends a command that outlived its timeout.
      await call(() => sandbox.process.deleteSession(session)).catch(() => undefined);
    }
  }

  return defineProvider({
    name,
    capabilities: ["pause", "snapshot", "ttl", "ports", "desktop", "background", "persistentDisk"] as const,

    async create(createOptions = {}) {
      const key = createOptions.idempotencyKey;
      const labels = { ...createOptions.labels, ...(key ? { [IDEMPOTENCY_LABEL]: key } : {}) };
      // Daytona has no idempotency key, but sandbox names are unique: a name derived from the key makes a retried
      // create collide with the first one, which is then returned.
      const sandboxName = key ? `open-sb-${createHash("sha256").update(key).digest("hex").slice(0, 40)}` : undefined;
      const snapshot = createOptions.image ?? options.snapshot;
      const params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams = {
        labels, name: sandboxName, autoStopInterval: options.autoStopInterval,
        ...(snapshot ? { snapshot } : options.image ? { image: options.image } : {}),
      };
      return info(await call(async daytona => {
        try {
          return await daytona.create(params, { timeout: SLOW });
        } catch (error) {
          // Created but still starting when the SDK stopped waiting: return it as starting.
          if (error instanceof DaytonaTimeoutError && error.sandboxId) return daytona.get(error.sandboxId);
          // The name is taken: an earlier attempt with the same key created it.
          if (sandboxName && error instanceof DaytonaConflictError) {
            const existing = await daytona.get(sandboxName);
            if (existing.labels?.[IDEMPOTENCY_LABEL] === key) return existing;
          }
          throw error;
        }
      }, createOptions.signal, (SLOW + 60) * 1000));
    },

    async get(id, callOptions = {}) {
      try {
        return info(await call(daytona => daytona.get(id), callOptions.signal));
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      try {
        const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
        if (sandbox.state === "destroyed" || sandbox.state === "destroying") return;
        await call(() => sandbox.delete(60), callOptions.signal, 90_000);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    async exec(id, command, execOptions = {}) {
      const result = await run(id, command, execOptions);
      return { exitCode: result.exitCode ?? 128, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },

    async readFile(id, path, callOptions = {}) {
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      const bytes = await call(() => sandbox.fs.downloadFile(path, SLOW), callOptions.signal, (SLOW + 15) * 1000);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },

    async writeFile(id, path, data, callOptions = {}) {
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      const directory = path.slice(0, path.lastIndexOf("/"));
      // Upload does not promise to create parent folders. A failure here (often "exists") resurfaces in the upload.
      if (directory) await call(() => sandbox.fs.createFolder(directory, "755"), callOptions.signal).catch(error => {
        if (callOptions.signal?.aborted) throw error;
      });
      await call(() => sandbox.fs.uploadFile(bytes, path, SLOW), callOptions.signal, (SLOW + 15) * 1000);
    },

    /** Stop keeps the disk; Daytona archives a sandbox stopped for long (7 days by default) and restores it on start. */
    async pause(id, callOptions = {}) {
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      if (info(sandbox).state === "stopped") return;
      await call(() => sandbox.stop(SLOW), callOptions.signal, (SLOW + 30) * 1000);
    },

    async resume(id, callOptions = {}) {
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      if (sandbox.state === "started") return;
      await call(() => sandbox.start(SLOW), callOptions.signal, (SLOW + 30) * 1000);
    },

    async snapshot(id, snapshot, callOptions = {}) {
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      await call(() => sandbox.createSnapshot(snapshot, SLOW), callOptions.signal, (SLOW + 30) * 1000);
      // The sandbox leaves `snapshotting` before the snapshot may be usable; `create` needs it active.
      const until = Date.now() + SLOW * 1000;
      for (;;) {
        const state = (await call(daytona => daytona.snapshot.get(snapshot), callOptions.signal)).state;
        if (state === "active") return;
        if (state === "error" || state === "build_failed") throw new SandboxError("unavailable", name, { code: "snapshot_failed" });
        if (Date.now() > until) throw new SandboxError("timeout", name, { code: "snapshot_timeout" });
        await new Promise(done => setTimeout(done, 2_000));
      }
    },

    /** The organization's own snapshots; Daytona's shared (`general`) ones are left out. */
    async listSnapshots(callOptions = {}) {
      const names: string[] = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const result = await call(daytona => daytona.snapshot.list({ page, limit: 100 }), callOptions.signal);
        names.push(...result.items.filter(snapshot => !snapshot.general).map(snapshot => snapshot.name));
        pages = result.totalPages;
      }
      return names;
    },

    async deleteSnapshot(snapshot, callOptions = {}) {
      try {
        await call(daytona => daytona.snapshot.delete(snapshot), callOptions.signal);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    /** Deletes the sandbox and its disk `seconds` from now (rounded up to whole minutes); calling again re-anchors it. */
    async setTtl(id, seconds, callOptions = {}) {
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      await call(() => sandbox.setTtl(minutes), callOptions.signal);
    },

    /** Private sandboxes answer the preview URL only with the token header; keep both server-side. */
    async portUrl(id, port, callOptions = {}) {
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      const link = await call(() => sandbox.getPreviewLink(port), callOptions.signal);
      return link.token ? { url: link.url, headers: { "X-Daytona-Preview-Token": link.token } } : { url: link.url };
    },

    /** A signed port URL authenticates the HTML, its assets and WebSocket without exposing the API key. */
    async desktop(id, callOptions = {}) {
      const sandbox = await call(daytona => daytona.get(id), callOptions.signal);
      if (info(sandbox).state !== "running")
        throw new SandboxError("rejected", name, { code: "desktop_requires_running_sandbox" });
      // Daytona's start operation is idempotent; it also restores desktop processes after sandbox resume.
      await call(() => sandbox.computerUse.start(), callOptions.signal, 120_000);
      const issuedAt = Date.now();
      const link = await call(() => sandbox.getSignedPreviewUrl(6080, desktopTtl), callOptions.signal);
      const viewer = new URL("/vnc.html", link.url);
      viewer.search = new URLSearchParams({ autoconnect: "true", resize: "scale", reconnect: "true", view_only: "true", path: "websockify" }).toString();
      const socket = new URL("/websockify", link.url);
      socket.protocol = "wss:";
      return { url: viewer.href, websocketUrl: socket.href, expiresAt: new Date(issuedAt + desktopTtl * 1000) };
    },

    /** Runs in its own session, left open: deleting the session would end the process. */
    async startBackground(id, command, execOptions = {}) {
      const full = script(command, execOptions);
      const session = `open-sb-bg-${randomUUID()}`;
      const sandbox = await call(daytona => daytona.get(id), execOptions.signal);
      await call(() => sandbox.process.createSession(session), execOptions.signal);
      const result = await call(() => sandbox.process.executeSessionCommand(session, { command: full, runAsync: true }), execOptions.signal);
      if (typeof result.exitCode === "number" && result.exitCode !== 0)
        throw new SandboxError("rejected", name, { code: "background_start_failed" });
    },
  });
}
