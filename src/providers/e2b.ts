// E2B (e2b.dev): Firecracker microVMs started from templates. Pause keeps memory and disk, named snapshots
// start new sandboxes, ports get public HTTPS hosts. No SSH and no desktop through the SDK. A sandbox lives
// at most 24 hours (1 hour on the Hobby plan) and is killed when its timeout runs out.
// Uses the official `e2b` SDK (a peer dependency).
import { createHash } from "node:crypto";
import {
  AuthenticationError, CommandExitError, FileNotFoundError, GuestUnresponsiveError, InvalidArgumentError,
  NotEnoughSpaceError, NotFoundError, RateLimitError, Sandbox, SandboxError as E2BError, SandboxNotRunningError,
  SandboxUnreachableError, ServiceBusyError, TemplateError, TimeoutError, type SandboxInfo as E2BInfo,
} from "e2b";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { ExecOptions, SandboxInfo } from "../types.ts";

export interface E2BOptions {
  /** Default: the SDK reads `E2B_API_KEY`. */
  apiKey?: string;
  /** Template for new sandboxes when `create` names no image. Default: the SDK's `base`. */
  template?: string;
  /** Lifetime given to new and resumed sandboxes. Default 900 s; extend with `setTtl`. */
  ttlSeconds?: number;
  name?: string;
  /** Override for tests: a substitute for the SDK's `Sandbox` class. */
  Sandbox?: typeof Sandbox;
}

/** E2B accepts lowercase letters, digits and hyphens; other keys are hashed into that alphabet. */
const idempotencyKey = (key: string) => /^[a-z0-9-]{1,255}$/.test(key) ? key : createHash("sha256").update(key).digest("hex");
/** Snapshot names come back as `team-slug/name:tag`; callers know them as `name`. */
const snapshotName = (full: string) => full.replace(/^.*\//, "").replace(/:(latest|default)$/, "");

export function e2b(options: E2BOptions = {}) {
  const name = options.name ?? "e2b";
  const ttlSeconds = options.ttlSeconds ?? 900;
  const SDK = options.Sandbox ?? Sandbox;
  const auth = options.apiKey ? { apiKey: options.apiKey } : {};
  /** Connected sandboxes, so exec and files skip the connect call. */
  const connected = new Map<string, Sandbox>();

  /** Maps SDK failures onto SandboxError; SDK messages carry provider bodies, so none reach ours. */
  function fail(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted) return signal.reason ?? error;
    if (error instanceof SandboxError) return error;
    if (error instanceof AuthenticationError) return new SandboxError("rejected", name, { status: 401, code: "unauthorized" });
    if (error instanceof RateLimitError) return new SandboxError("unavailable", name, { status: 429, code: "rate_limited" });
    if (error instanceof ServiceBusyError) return new SandboxError("unavailable", name, { status: 503, code: "busy" });
    if (error instanceof FileNotFoundError) return new SandboxError("not_found", name, { code: "file_not_found" });
    if (error instanceof NotFoundError) return new SandboxError("not_found", name, { status: 404 });
    if (error instanceof SandboxNotRunningError) return new SandboxError("not_found", name, { code: "not_running" });
    // Before TimeoutError, its parent: the sandbox or the network between us is down.
    if (error instanceof SandboxUnreachableError) return httpError(name, null, "unreachable");
    if (error instanceof TimeoutError) return new SandboxError("timeout", name, { code: "timeout" });
    if (error instanceof GuestUnresponsiveError) return new SandboxError("rejected", name, { code: "guest_unresponsive" });
    if (error instanceof InvalidArgumentError || error instanceof TemplateError || error instanceof NotEnoughSpaceError)
      return new SandboxError("rejected", name, { status: error.statusCode, code: error.name });
    if (error instanceof E2BError)
      return error.statusCode ? httpError(name, error.statusCode) : new SandboxError("rejected", name, { code: "sdk_error" });
    // The SDK's own request timeout aborts fetch with a DOMException; a failed fetch is a TypeError.
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      return new SandboxError("timeout", name, { code: "request_timeout" });
    if (error instanceof TypeError) return httpError(name, null, "network");
    return error;
  }

  async function call<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw fail(error, signal);
    }
  }

  /** Runs `work` on a connected sandbox. Connecting resumes a paused one; a stale connection is retried once. */
  async function withSandbox<T>(id: string, signal: AbortSignal | undefined, work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let sandbox = connected.get(id);
      if (!sandbox) {
        sandbox = await call(() => SDK.connect(id, { ...auth, signal }), signal);
        connected.set(id, sandbox);
      }
      try {
        return await work(sandbox);
      } catch (error) {
        if (!(error instanceof SandboxNotRunningError)) throw error;
        connected.delete(id);
        if (attempt > 0 || signal?.aborted) throw fail(error, signal);
      }
    }
  }

  const info = (sandbox: E2BInfo): SandboxInfo => ({
    id: sandbox.sandboxId,
    state: sandbox.state === "running" ? "running" : sandbox.state === "paused" ? "stopped" : "starting",
    labels: { ...sandbox.metadata },
    createdAt: sandbox.startedAt,
    // A paused sandbox has no running timeout.
    expiresAt: sandbox.state === "running" ? sandbox.endAt : undefined,
  });

  async function list(filter: { labels?: Record<string, string>; signal?: AbortSignal } = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    const pages = SDK.list({ ...auth, ...(wanted.length ? { query: { metadata: filter.labels } } : {}) });
    const found: SandboxInfo[] = [];
    while (pages.hasNext) found.push(...(await call(() => pages.nextItems({ ...auth, signal: filter.signal }), filter.signal)).map(info));
    // The API filters already; checking again keeps `list` exact whatever the server matches.
    return found.filter(sandbox => wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  async function run(id: string, command: string, execOptions: ExecOptions = {}) {
    const { signal } = execOptions;
    return withSandbox(id, signal, async sandbox => {
      try {
        const result = await sandbox.commands.run(command, { cwd: execOptions.cwd, envs: execOptions.env, signal,
          timeoutMs: execOptions.timeoutMs ?? 300_000 });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        // E2B throws on a nonzero exit; open-sb reports it.
        if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        if (error instanceof SandboxNotRunningError) throw error;
        throw fail(error, signal);
      }
    });
  }

  return defineProvider({
    name,
    capabilities: ["pause", "snapshot", "ttl", "ports", "background", "persistentDisk"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const labels = { ...createOptions.labels };
      const sandbox = await call(() => SDK.create({ ...auth, signal, requestTimeoutMs: 300_000,
        template: createOptions.image ?? options.template, metadata: labels, timeoutMs: ttlSeconds * 1000,
        ...(createOptions.idempotencyKey ? { idempotencyKey: idempotencyKey(createOptions.idempotencyKey) } : {}) }), signal);
      connected.set(sandbox.sandboxId, sandbox);
      const now = Date.now();
      return { id: sandbox.sandboxId, state: "running", labels, createdAt: new Date(now), expiresAt: new Date(now + ttlSeconds * 1000) };
    },

    async get(id, callOptions = {}) {
      try {
        return info(await call(() => SDK.getInfo(id, { ...auth, signal: callOptions.signal }), callOptions.signal));
      } catch (error) {
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      connected.delete(id);
      // `kill` answers false for a sandbox that is already gone.
      await call(() => SDK.kill(id, { ...auth, signal: callOptions.signal }), callOptions.signal);
    },

    exec: run,

    async readFile(id, path, callOptions = {}) {
      const { signal } = callOptions;
      return withSandbox(id, signal, sandbox => sandbox.files.read(path, { format: "bytes", signal })
        .catch(error => { throw error instanceof SandboxNotRunningError ? error : fail(error, signal); }));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const { signal } = callOptions;
      // The SDK creates missing parent directories.
      await withSandbox(id, signal, sandbox => sandbox.files.write(path, data, { signal })
        .catch(error => { throw error instanceof SandboxNotRunningError ? error : fail(error, signal); }));
    },

    /** Keeps memory and disk; `resume` restores both. */
    async pause(id, callOptions = {}) {
      connected.delete(id);
      await call(() => SDK.pause(id, { ...auth, signal: callOptions.signal, requestTimeoutMs: 300_000 }), callOptions.signal);
    },

    async resume(id, callOptions = {}) {
      const { signal } = callOptions;
      const sandbox = await call(() => SDK.connect(id, { ...auth, signal, requestTimeoutMs: 300_000, timeoutMs: ttlSeconds * 1000 }), signal);
      connected.set(id, sandbox);
    },

    /** E2B pauses the sandbox while it takes the snapshot; the next call reconnects, resuming it if needed. */
    async snapshot(id, snapshot, callOptions = {}) {
      connected.delete(id);
      await call(() => SDK.createSnapshot(id, { ...auth, name: snapshot, signal: callOptions.signal, requestTimeoutMs: 600_000 }), callOptions.signal);
    },

    async listSnapshots(callOptions = {}) {
      const pages = SDK.listSnapshots(auth);
      const names = new Set<string>();
      while (pages.hasNext)
        for (const snapshot of await call(() => pages.nextItems({ ...auth, signal: callOptions.signal }), callOptions.signal))
          for (const full of snapshot.names) names.add(snapshotName(full));
      return [...names];
    },

    /** Deleting a missing snapshot is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      const { signal } = callOptions;
      const pages = SDK.listSnapshots({ ...auth, name: snapshot });
      const ids: string[] = [];
      while (pages.hasNext)
        for (const found of await call(() => pages.nextItems({ ...auth, signal }), signal))
          if (found.names.some(full => snapshotName(full) === snapshot)) ids.push(found.snapshotId);
      for (const snapshotId of ids) await call(() => SDK.deleteSnapshot(snapshotId, { ...auth, signal }), signal);
    },

    async setTtl(id, seconds, callOptions = {}) {
      await call(() => SDK.setTimeout(id, seconds * 1000, { ...auth, signal: callOptions.signal }), callOptions.signal);
    },

    /** A public HTTPS host. Sandboxes created with restricted public traffic also need the returned header. */
    async portUrl(id, port, callOptions = {}) {
      return withSandbox(id, callOptions.signal, async sandbox => ({
        url: `https://${sandbox.getHost(port)}`,
        ...(sandbox.trafficAccessToken ? { headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken } } : {}),
      }));
    },

    async startBackground(id, command, execOptions = {}) {
      const { signal } = execOptions;
      await withSandbox(id, signal, async sandbox => {
        const handle = await sandbox.commands.run(command, { background: true, cwd: execOptions.cwd, envs: execOptions.env, signal })
          .catch(error => { throw error instanceof SandboxNotRunningError ? error : fail(error, signal); });
        // Disconnecting stops the event stream without killing the process.
        await handle.disconnect();
      });
    },
  });
}
