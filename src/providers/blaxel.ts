// Blaxel (blaxel.ai): perpetual microVM sandboxes that go to standby when idle and wake, memory and processes
// intact, on the next request. Uses the official `@blaxel/core` SDK (a peer dependency). The sandbox name is
// its ID. Capabilities:
// - pause: Blaxel's automatic standby is invisible (the sandbox stays DEPLOYED and wakes on any call), so it
//   cannot be `pause`. Archive is the explicit one: the filesystem is exported and the VM shut down (ARCHIVED,
//   reported as "stopped"); unarchive writes the files back (persistentDisk). Memory and processes are lost.
// - snapshot: workspace snapshots, forked into new sandboxes. Blaxel keeps names unique per source sandbox
//   only, so `create({ image })` uses the newest ready snapshot with that name, and deleteSnapshot removes all.
// - ttl: a `date` expiration policy (Blaxel deletes the sandbox then); get() reports it from `expiresIn`.
// - ports: preview URLs, private by default, with an `X-Blaxel-Preview-Token` header.
// - background: processes started without waiting; they survive standby.
// Left out: ssh (no SSH endpoint), desktop (no viewer). Limits: the SDK reads credentials from one global
// setting, so every Blaxel provider in a process shares one workspace; control-plane calls take no
// AbortSignal, so an abort or timeout stops waiting while the request itself runs to completion at Blaxel.
// Labels are filtered here: Blaxel's list has only a substring search.
import { createHash, randomUUID } from "node:crypto";
import {
  CredentialsError, getBlaxelErrorCode, getBlaxelErrorStatus, initialize, SandboxInstance, Snapshot,
  type SandboxCreateConfiguration,
} from "@blaxel/core";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, SandboxInfo, SandboxState } from "../types.ts";

type Policy = { type?: "ttl-idle" | "ttl-max-age" | "date"; value?: string; action?: "delete" };
type Lifecycle = { expirationPolicies?: Policy[]; terminatedRetention?: string };
type ProcessResult = { pid: string; status: string; exitCode: number; stdout: string; stderr: string };

/** The parts of a Blaxel sandbox this provider uses; the SDK's `SandboxInstance` satisfies it. */
export interface BlaxelSandbox {
  metadata: { name: string; labels?: Record<string, string>; createdAt?: string };
  status?: string;
  expiresIn?: number;
  spec: { lifecycle?: Lifecycle };
  fs: {
    readBinary(path: string): Promise<Blob>;
    writeBinary(path: string, content: Uint8Array): Promise<unknown>;
  };
  process: {
    exec(request: { command: string; env?: Record<string, string>; workingDir?: string; timeout?: number }): Promise<ProcessResult>;
    wait(identifier: string, options: { maxWait?: number; signal?: AbortSignal }): Promise<ProcessResult>;
    logs(identifier: string, type: "stdout" | "stderr"): Promise<string>;
    kill(identifier: string): Promise<unknown>;
  };
  previews: {
    createIfNotExists(preview: { port: number; public?: boolean }): Promise<{
      url: string; spec: { public?: boolean }; tokens: { createIfExpired(): Promise<{ value: string }> };
    }>;
  };
}

/** A workspace snapshot; the SDK's `Snapshot` satisfies it. */
export interface BlaxelSnapshot {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  fork(targetName: string): Promise<unknown>;
}

/** The SDK calls this provider makes; the default wraps `SandboxInstance` and `Snapshot`, tests pass a fake. */
export interface BlaxelClient {
  create(config: SandboxCreateConfiguration): Promise<BlaxelSandbox>;
  createIfNotExists(config: SandboxCreateConfiguration): Promise<BlaxelSandbox>;
  get(name: string): Promise<BlaxelSandbox>;
  list(query: { limit: number }): Promise<AsyncIterable<BlaxelSandbox>>;
  delete(name: string): Promise<unknown>;
  archive(name: string, options: { maxWait: number }): Promise<unknown>;
  unarchive(name: string, options: { maxWait: number }): Promise<unknown>;
  updateMetadata(name: string, metadata: { labels: Record<string, string> }): Promise<BlaxelSandbox>;
  updateLifecycle(name: string, lifecycle: Lifecycle): Promise<unknown>;
  snapshots: {
    create(config: { name: string; source: { name: string } }): Promise<BlaxelSnapshot>;
    get(id: string): Promise<BlaxelSnapshot>;
    list(query: { limit: number }): Promise<AsyncIterable<BlaxelSnapshot>>;
    delete(id: string): Promise<void>;
  };
}

export interface BlaxelOptions {
  /** Default: `BL_API_KEY`, then the Blaxel CLI login. Set with `workspace`; the SDK keeps both globally. */
  apiKey?: string;
  /** Default: `BL_WORKSPACE`, then the Blaxel CLI login. */
  workspace?: string;
  /** Region of new sandboxes, for example `us-pdx-1` or `eu-lon-1`. Default: `BL_REGION`, else Blaxel picks. */
  region?: string;
  /** Image when `create` names none. Default `blaxel/base-image:latest`. */
  image?: string;
  /** Memory of new sandboxes in MB (CPUs = memory / 2048). Default: the SDK's 4096. */
  memory?: number;
  /** Delete new sandboxes this many seconds after creation unless `setTtl` moves it. Default: never. */
  ttlSeconds?: number;
  /** Open new port previews to anyone instead of requiring the token header. Default false. */
  publicPorts?: boolean;
  /** Substitute for the SDK; replaces `apiKey` and `workspace`. */
  client?: BlaxelClient;
  name?: string;
}

const STATES: Record<string, SandboxState> = {
  UPLOADING: "starting", BUILDING: "starting", BUILT: "starting", DEPLOYING: "starting", UNARCHIVING: "starting",
  DEPLOYED: "running",
  ARCHIVING: "stopped", ARCHIVED: "stopped", DEACTIVATING: "stopped", DEACTIVATED: "stopped",
  DELETING: "gone", TERMINATED: "gone", FAILED: "gone",
};
/** Codes Blaxel marks as passing: the platform, not the request, failed. */
const TRANSIENT = new Set([
  "WORKLOAD_UNAVAILABLE", "ROUTING_UNAVAILABLE", "UPSTREAM_CONNECT_FAILED", "UPSTREAM_CONNECT_TIMEOUT", "UPSTREAM_ERROR",
  "UPSTREAM_TIMEOUT", "GATEWAY_INTERNAL_ERROR", "AUTHENTICATION_UNAVAILABLE", "SERVICE_UNAVAILABLE",
  "RATE_LIMIT_EXCEEDED", "WORKSPACE_RATE_LIMIT_EXCEEDED", "CLUSTER_GATEWAY_ERROR", "LOCK_ACQUISITION_FAILED",
]);
/** Holds a hash of the idempotency key; label values stay short and plain. */
const IDEMPOTENCY_LABEL = "open-sb.idempotency";
/** Output a finished process reports inline; longer output is fetched from its logs. */
const INLINE_OUTPUT = 64 * 1024;
const SLOW_MS = 600_000;

const hash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 40);

function defaultClient(): BlaxelClient {
  return {
    create: config => SandboxInstance.create(config),
    createIfNotExists: config => SandboxInstance.createIfNotExists(config),
    get: name => SandboxInstance.get(name),
    list: query => SandboxInstance.list(query),
    delete: name => SandboxInstance.delete(name),
    archive: (name, options) => SandboxInstance.archive(name, options),
    unarchive: (name, options) => SandboxInstance.unarchive(name, options),
    updateMetadata: (name, metadata) => SandboxInstance.updateMetadata(name, metadata),
    updateLifecycle: (name, lifecycle) => SandboxInstance.updateLifecycle(name, lifecycle),
    snapshots: {
      create: config => Snapshot.create(config),
      get: id => Snapshot.get(id),
      list: query => Snapshot.list(query),
      delete: id => Snapshot.delete(id),
    },
  };
}

export function blaxel(options: BlaxelOptions = {}) {
  const name = options.name ?? "blaxel";
  if (!options.client && (options.apiKey || options.workspace)) initialize({ apiKey: options.apiKey, workspace: options.workspace });
  const client = options.client ?? defaultClient();

  /** Maps SDK failures onto SandboxError; Blaxel's messages carry names and bodies, so none reach ours. */
  function translate(error: unknown): unknown {
    if (error instanceof SandboxError) return error;
    if (error instanceof CredentialsError) return new SandboxError("rejected", name, { code: "credentials" });
    const status = getBlaxelErrorStatus(error);
    const raw = getBlaxelErrorCode(error);
    const code = typeof raw === "string" ? raw : undefined;
    if (code && TRANSIENT.has(code)) return new SandboxError("unavailable", name, { status, code });
    if (status) return httpError(name, status, code);
    // A failed fetch is a TypeError; a reset HTTP/2 stream or socket carries a system code such as ECONNRESET.
    if (error instanceof TypeError) return httpError(name, null, "network");
    const errno = (error as { code?: unknown } | null)?.code;
    if (typeof errno === "string" && /^(E[A-Z_]+|ERR_HTTP2_[A-Z_]+)$/.test(errno)) return httpError(name, null, "network");
    if (error instanceof Error) return error;
    return new SandboxError("rejected", name, { code: "sdk_error" });
  }

  /** Runs one SDK call, stopping the wait (not the request) on abort or after `timeoutMs`. */
  async function call<T>(work: () => Promise<T>, signal?: AbortSignal, timeoutMs = 120_000): Promise<T> {
    signal?.throwIfAborted();
    let stop = () => {};
    const stopped = new Promise<never>((_, fail) => {
      const timer = setTimeout(() => fail(new SandboxError("timeout", name, { code: "request_timeout" })), timeoutMs);
      const abort = () => fail(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    });
    try {
      return await Promise.race([Promise.resolve().then(work), stopped]);
    } catch (error) {
      throw signal?.aborted ? signal.reason : translate(error);
    } finally {
      stop();
    }
  }

  const notFound = (error: unknown) => error instanceof SandboxError && error.kind === "not_found";
  const sandbox = (id: string, signal?: AbortSignal) => call(() => client.get(id), signal);

  const info = (found: BlaxelSandbox): SandboxInfo => ({
    id: found.metadata.name,
    state: STATES[String(found.status)] ?? "starting",
    labels: { ...found.metadata.labels },
    createdAt: found.metadata.createdAt ? new Date(found.metadata.createdAt) : undefined,
    expiresAt: typeof found.expiresIn === "number" ? new Date(Date.now() + found.expiresIn * 1000) : undefined,
  });

  async function snapshots(signal?: AbortSignal) {
    return call(async () => {
      const found: BlaxelSnapshot[] = [];
      for await (const snapshot of await client.snapshots.list({ limit: 200 })) {
        signal?.throwIfAborted();
        found.push(snapshot);
      }
      return found;
    }, signal, SLOW_MS);
  }

  /** Polls until the snapshot can be forked. */
  async function ready(snapshot: BlaxelSnapshot, signal?: AbortSignal) {
    for (const until = Date.now() + SLOW_MS; ;) {
      if (snapshot.status === "ready") return;
      if (snapshot.status === "failed") throw new SandboxError("unavailable", name, { code: "snapshot_failed" });
      if (Date.now() > until) throw new SandboxError("timeout", name, { code: "snapshot_timeout" });
      await new Promise(done => setTimeout(done, 2_000));
      snapshot = await call(() => client.snapshots.get(snapshot.id), signal);
    }
  }

  /** A new sandbox forked from a snapshot, labelled afterwards: a fork takes no labels. */
  async function fork(snapshot: BlaxelSnapshot, labels: Record<string, string>, target: string | undefined, signal?: AbortSignal) {
    const sandboxName = target ?? `osb-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    try {
      await call(() => snapshot.fork(sandboxName), signal, SLOW_MS);
    } catch (error) {
      // The name is taken: an earlier attempt with the same key forked it.
      if (!target || !(error instanceof SandboxError && error.status === 409)) throw error;
      const existing = await sandbox(sandboxName, signal);
      if (existing.metadata.labels?.[IDEMPOTENCY_LABEL] !== labels[IDEMPOTENCY_LABEL])
        throw new SandboxError("rejected", name, { status: 409, code: "name_taken" });
      return info(existing);
    }
    return info(await call(() => client.updateMetadata(sandboxName, { labels }), signal));
  }

  async function lookup(id: string, callOptions: CallOptions = {}) {
    try {
      return info(await sandbox(id, callOptions.signal));
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async function stopProcess(found: BlaxelSandbox, pid: string) {
    await call(() => found.process.kill(pid)).catch(() => undefined);
  }

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "snapshot", "ttl", "ports", "background"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const key = createOptions.idempotencyKey;
      const labels = { ...createOptions.labels, ...(key ? { [IDEMPOTENCY_LABEL]: hash(key) } : {}) };
      // Names are unique in a workspace: one derived from the key makes a retried create find the first one.
      const sandboxName = key ? `osb-${hash(key)}` : undefined;
      if (createOptions.image) {
        const saved = (await snapshots(signal)).filter(snapshot => snapshot.name === createOptions.image && snapshot.status !== "failed")
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (saved) {
          await ready(saved, signal);
          return fork(saved, labels, sandboxName, signal);
        }
      }
      const config: SandboxCreateConfiguration = {
        name: sandboxName, image: createOptions.image ?? options.image, labels, region: options.region, memory: options.memory,
        ...(options.ttlSeconds ? { lifecycle: { expirationPolicies: [
          { type: "date", value: new Date(Date.now() + options.ttlSeconds * 1000).toISOString(), action: "delete" }] } } : {}),
      };
      // createIfNotExists returns the live sandbox holding the name, which an earlier attempt with this key created.
      const created = await call(() => key ? client.createIfNotExists(config) : client.create(config), signal, SLOW_MS);
      if (key && created.metadata.labels?.[IDEMPOTENCY_LABEL] !== labels[IDEMPOTENCY_LABEL])
        throw new SandboxError("rejected", name, { status: 409, code: "name_taken" });
      return info(created);
    },

    get: lookup,

    async list(filter = {}) {
      const wanted = Object.entries(filter.labels ?? {});
      return call(async () => {
        const found: SandboxInfo[] = [];
        for await (const item of await client.list({ limit: 200 })) {
          filter.signal?.throwIfAborted();
          if (wanted.every(([key, value]) => item.metadata.labels?.[key] === value)) found.push(info(item));
        }
        return found;
      }, filter.signal, SLOW_MS);
    },

    async destroy(id, callOptions = {}) {
      try {
        await call(() => client.delete(id), callOptions.signal);
      } catch (error) {
        if (notFound(error)) return;
        // A deletion already under way may be refused; it is not an error if the sandbox is going anyway.
        const current = await lookup(id, callOptions);
        if (current && current.state !== "gone") throw error;
      }
    },

    async exec(id, command, execOptions: ExecOptions = {}) {
      const { signal } = execOptions;
      const timeoutMs = execOptions.timeoutMs ?? SLOW_MS;
      const found = await sandbox(id, signal);
      // Started without waiting: a held request is cut by Blaxel's edge after 120 s. `timeout` kills it in the VM.
      const started = await call(() => found.process.exec({ command, env: execOptions.env, workingDir: execOptions.cwd,
        timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) }), signal);
      let done: ProcessResult;
      try {
        done = await call(() => found.process.wait(started.pid, { maxWait: timeoutMs + 5_000, signal }), signal, timeoutMs + 30_000);
      } catch (error) {
        await stopProcess(found, started.pid);
        // The SDK reports a wait that ran out as a plain error.
        if (signal?.aborted || (error instanceof SandboxError && error.kind !== "timeout")) throw error;
        throw new SandboxError("timeout", name, { code: "exec_timeout" });
      }
      if (done.status === "killed") throw new SandboxError("timeout", name, { code: "exec_timeout" });
      const output = (stream: "stdout" | "stderr") => done[stream].length < INLINE_OUTPUT ? done[stream]
        : call(() => found.process.logs(started.pid, stream), signal);
      return { exitCode: done.exitCode ?? 0, stdout: await output("stdout"), stderr: await output("stderr") };
    },

    async readFile(id, path, callOptions = {}) {
      const found = await sandbox(id, callOptions.signal);
      const blob = await call(() => found.fs.readBinary(path), callOptions.signal, SLOW_MS);
      return new Uint8Array(await blob.arrayBuffer());
    },

    async writeFile(id, path, data, callOptions = {}) {
      // Bytes always: given a string, writeBinary reads a local file of that name. Parents are created.
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const found = await sandbox(id, callOptions.signal);
      await call(() => found.fs.writeBinary(path, bytes), callOptions.signal, SLOW_MS);
    },

    /** Archives: the files are kept, memory and processes are not. */
    async pause(id, callOptions = {}) {
      const found = await sandbox(id, callOptions.signal);
      if (found.status === "ARCHIVED" || found.status === "ARCHIVING") return;
      await call(() => client.archive(id, { maxWait: SLOW_MS }), callOptions.signal, SLOW_MS + 30_000);
    },

    async resume(id, callOptions = {}) {
      const found = await sandbox(id, callOptions.signal);
      if (found.status === "DEPLOYED") return;
      await call(() => client.unarchive(id, { maxWait: SLOW_MS }), callOptions.signal, SLOW_MS + 30_000);
    },

    async snapshot(id, snapshot, callOptions = {}) {
      const { signal } = callOptions;
      const created = await call(() => client.snapshots.create({ name: snapshot, source: { name: id } }), signal, SLOW_MS);
      await ready(created, signal);
    },

    async listSnapshots(callOptions = {}) {
      return [...new Set((await snapshots(callOptions.signal)).filter(item => item.status !== "failed").map(item => item.name))];
    },

    /** Every snapshot with this name, from whichever sandbox; a missing one is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      for (const found of (await snapshots(callOptions.signal)).filter(item => item.name === snapshot))
        await call(() => client.snapshots.delete(found.id), callOptions.signal).catch(error => { if (!notFound(error)) throw error; });
    },

    /** Replaces only the `date` policy; Blaxel deletes the sandbox at that time. */
    async setTtl(id, seconds, callOptions = {}) {
      const found = await sandbox(id, callOptions.signal);
      const lifecycle = found.spec.lifecycle ?? {};
      const policies = (lifecycle.expirationPolicies ?? []).filter(policy => policy.type !== "date");
      policies.push({ type: "date", value: new Date(Date.now() + seconds * 1000).toISOString(), action: "delete" });
      await call(() => client.updateLifecycle(id, { ...lifecycle, expirationPolicies: policies }), callOptions.signal);
    },

    /** A private preview answers only with the token header; keep both server-side. */
    async portUrl(id, port, callOptions = {}) {
      const { signal } = callOptions;
      const found = await sandbox(id, signal);
      const preview = await call(() => found.previews.createIfNotExists({ port, public: options.publicPorts ?? false }), signal);
      if (preview.spec.public) return { url: preview.url };
      const token = await call(() => preview.tokens.createIfExpired(), signal);
      return { url: preview.url, headers: { "X-Blaxel-Preview-Token": token.value } };
    },

    /** Runs until it ends or the sandbox is deleted; standby suspends and resumes it with the VM. */
    async startBackground(id, command, execOptions = {}) {
      const { signal } = execOptions;
      const found = await sandbox(id, signal);
      const started = await call(() => found.process.exec({ command, env: execOptions.env, workingDir: execOptions.cwd }), signal);
      if (started.status === "failed") throw new SandboxError("rejected", name, { code: "background_start_failed" });
    },
  });
}
