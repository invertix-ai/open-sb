// Morph Cloud (cloud.morph.so): VMs that always start from a snapshot, with pause and resume that keep memory
// and disk, snapshots of a running VM, public HTTPS services for ports and a TTL Morph enforces itself. Uses the
// official `morphcloud` SDK (a peer dependency). Limits:
// - With no `image`, a base snapshot is built once from the `morphvm-minimal` image and found again by its
//   digest. `image` may name an open-sb snapshot, a Morph snapshot id (`snapshot_...`) or a Morph image id.
// - Snapshot names are kept in snapshot metadata (Morph assigns the ids); the newest snapshot with a name wins.
// - Files travel through exec as base64, one call per 48 KiB written: the SDK's only file path is SFTP through
//   Morph's SSH gateway on port 22, which many hosts cannot reach.
// - No `ssh`: Morph's gateway signs in with the account API key in the user name, not with a caller's key, and
//   the SDK offers no way to authorize one. No `desktop`.
// - Port URLs are public: anyone with the URL reaches the port.
// - Morph has no idempotency key: a label lookup before create catches a retry after a lost response, not two
//   creates racing each other.
// - The SDK takes no AbortSignal and its error messages carry response bodies: an abort or timeout stops
//   waiting while the request runs on at Morph, and errors are mapped from the HTTP status alone.
import { createHash, randomUUID } from "node:crypto";
import { MorphCloudClient } from "morphcloud";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

/** The parts of a Morph snapshot this provider uses; the SDK's `Snapshot` satisfies it. */
export interface MorphSnapshot {
  id: string;
  status: string;
  created: number;
  metadata?: Record<string, string>;
  delete(): Promise<void>;
}

/** The parts of a Morph instance this provider uses; the SDK's `Instance` satisfies it. */
export interface MorphInstance {
  id: string;
  status: string;
  created: number;
  metadata?: Record<string, string>;
  ttl?: { ttlExpireAt?: number };
  networking?: { httpServices?: { name: string; port: number; url: string }[] };
  pause(): Promise<void>;
  resume(): Promise<void>;
  exec(command: string, options?: { timeout?: number }): Promise<{ exit_code: number; stdout: string; stderr: string }>;
  snapshot(options?: { metadata?: Record<string, string> }): Promise<MorphSnapshot>;
  exposeHttpService(name: string, port: number): Promise<{ url: string }>;
  setTTL(ttlSeconds: number, ttlAction?: "stop" | "pause"): Promise<void>;
}

/** The parts of the Morph client this provider uses; `new MorphCloudClient()` satisfies it, and tests pass a fake. */
export interface MorphClient {
  snapshots: {
    list(options?: { digest?: string; metadata?: Record<string, string> }): Promise<MorphSnapshot[]>;
    create(options?: { imageId?: string; vcpus?: number; memory?: number; diskSize?: number; digest?: string; metadata?: Record<string, string> }): Promise<MorphSnapshot>;
    get(options: { snapshotId: string }): Promise<MorphSnapshot>;
  };
  instances: {
    list(options?: { metadata?: Record<string, string> }): Promise<MorphInstance[]>;
    start(options: { snapshotId: string; metadata?: Record<string, string>; ttlSeconds?: number; ttlAction?: "stop" | "pause"; timeout?: number }): Promise<MorphInstance>;
    get(options: { instanceId: string }): Promise<MorphInstance>;
    stop(options: { instanceId: string }): Promise<void>;
  };
}

export interface MorphOptions {
  /** Default: the `MORPH_API_KEY` environment variable, as the SDK reads it. */
  apiKey?: string;
  /** Default `https://cloud.morph.so/api`. */
  baseUrl?: string;
  /** Snapshot id for new instances when `create` names no image. Default: a base snapshot built from `image`. */
  snapshot?: string;
  /** Morph image the base snapshot is built from. Default `morphvm-minimal`. */
  image?: string;
  /** Size of a base snapshot built here. Default 1 vCPU, 1024 MB memory, 4096 MB disk. */
  vcpus?: number;
  memoryMb?: number;
  diskMb?: number;
  /** Lifetime given to new instances. Default: none (they run until destroyed); set one with `setTtl`. */
  ttlSeconds?: number;
  /** What Morph does when the TTL runs out: `pause` keeps the instance (default), `stop` deletes it. */
  ttlAction?: "pause" | "stop";
  /** A configured client; replaces `apiKey` and `baseUrl`. */
  client?: MorphClient;
  name?: string;
}

const STATES: Record<string, SandboxState> = {
  pending: "starting", ready: "running", saving: "running", paused: "stopped", error: "gone",
};
const IDEMPOTENCY_LABEL = "open-sb.idempotency-key";
/** Snapshot metadata key holding the caller's snapshot name. */
const SNAPSHOT_NAME = "open-sb.snapshot";
/** Snapshot metadata key marking base snapshots built here, so they are not listed as named ones. */
const BASE_IMAGE = "open-sb.base-image";
/** Seconds Morph may take to start, pause, resume or snapshot an instance. */
const SLOW = 300;
/** Base64 characters per write call: a multiple of 4, well under Linux's 128 KiB limit for one argument. */
const CHUNK = 49_152;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** Morph timestamps are Unix seconds; milliseconds are accepted too in case that changes. */
const date = (value: number | undefined) => value ? new Date(value < 1e12 ? value * 1000 : value) : undefined;
const usable = (snapshot: MorphSnapshot) => snapshot.status === "ready" || snapshot.status === "pending";
const newest = (snapshots: MorphSnapshot[]) => snapshots.sort((a, b) => b.created - a.created)[0];

export function morph(options: MorphOptions = {}) {
  const name = options.name ?? "morph";
  const ttlAction = options.ttlAction ?? "pause";
  let sdk = options.client;
  const client = () => sdk ??= new MorphCloudClient({ apiKey: options.apiKey, baseUrl: options.baseUrl }) satisfies MorphClient;
  /** Instance handles for exec and files; a handle holds only the id and the client. */
  const instances = new Map<string, MorphInstance>();
  /** Base snapshots being found or built, by digest. */
  const bases = new Map<string, Promise<string>>();

  /** Maps SDK failures onto SandboxError. The SDK throws plain Errors whose messages start `HTTP <status>`. */
  function translate(error: unknown): SandboxError {
    if (error instanceof SandboxError) return error;
    // The SDK's own request timeout aborts fetch with a DOMException; a failed fetch is a TypeError.
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      return new SandboxError("timeout", name, { code: "request_timeout" });
    if (error instanceof TypeError) return httpError(name, null, "network");
    const message = error instanceof Error ? error.message : "";
    const status = /^HTTP (\d{3})\b/.exec(message)?.[1];
    if (status) return httpError(name, Number(status));
    if (/timed out|did not become ready/i.test(message)) return new SandboxError("timeout", name, { code: "timeout" });
    if (/encountered an error/i.test(message)) return new SandboxError("unavailable", name, { code: "start_failed" });
    if (/expose HTTP service/i.test(message)) return new SandboxError("rejected", name, { code: "expose_failed" });
    return new SandboxError("unavailable", name, { code: "sdk_error" });
  }

  /** Runs one SDK call, honouring abort and a timeout (the SDK takes neither), with errors translated. */
  async function call<T>(work: (morph: MorphClient) => Promise<T>, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
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
      if (signal?.aborted) throw signal.reason ?? error;
      throw translate(error);
    } finally {
      stop();
    }
  }

  const notFound = (error: unknown) => error instanceof SandboxError && error.kind === "not_found";

  const info = (instance: MorphInstance, labels?: Labels): SandboxInfo => {
    const state = STATES[instance.status] ?? "starting";
    return {
      id: instance.id,
      state,
      labels: { ...(labels ?? instance.metadata) },
      createdAt: date(instance.created),
      // A paused instance has no running TTL.
      expiresAt: state === "running" ? date(instance.ttl?.ttlExpireAt) : undefined,
    };
  };

  async function instance(id: string, signal?: AbortSignal) {
    const cached = instances.get(id);
    if (cached) return cached;
    const found = await call(morph => morph.instances.get({ instanceId: id }), signal);
    instances.set(id, found);
    return found;
  }

  async function waitForSnapshot(snapshotId: string, signal?: AbortSignal) {
    const until = Date.now() + SLOW * 1000;
    for (;;) {
      const status = (await call(morph => morph.snapshots.get({ snapshotId }), signal)).status;
      if (status === "ready") return;
      if (status !== "pending") throw new SandboxError("unavailable", name, { code: "snapshot_failed" });
      if (Date.now() > until) throw new SandboxError("timeout", name, { code: "snapshot_timeout" });
      await new Promise(done => setTimeout(done, 1_000));
    }
  }

  /** A snapshot of a fresh VM from a Morph image, found by digest so it is built once per account and size. */
  function base(imageId: string, signal?: AbortSignal): Promise<string> {
    const spec = { imageId, vcpus: options.vcpus ?? 1, memory: options.memoryMb ?? 1024, diskSize: options.diskMb ?? 4096 };
    const digest = createHash("sha256").update(`open-sb:${JSON.stringify(spec)}`).digest("hex");
    let pending = bases.get(digest);
    if (!pending) {
      pending = (async () => {
        const existing = newest((await call(morph => morph.snapshots.list({ digest }), signal)).filter(usable));
        const snapshot = existing ?? await call(morph => morph.snapshots.create({ ...spec, digest, metadata: { [BASE_IMAGE]: imageId } }), signal, SLOW * 1000);
        await waitForSnapshot(snapshot.id, signal);
        return snapshot.id;
      })();
      bases.set(digest, pending);
      pending.catch(() => bases.delete(digest));
    }
    return pending;
  }

  async function named(snapshot: string, signal?: AbortSignal) {
    const found = await call(morph => morph.snapshots.list({ metadata: { [SNAPSHOT_NAME]: snapshot } }), signal);
    return found.filter(item => item.metadata?.[SNAPSHOT_NAME] === snapshot && item.status !== "deleted" && item.status !== "deleting");
  }

  /** The snapshot id a new instance starts from: an open-sb name first, then a Morph snapshot id, then a Morph image. */
  async function resolve(image: string | undefined, signal?: AbortSignal): Promise<string> {
    if (!image) return options.snapshot ?? base(options.image ?? "morphvm-minimal", signal);
    const match = newest((await named(image, signal)).filter(item => item.status === "ready"));
    if (match) return match.id;
    return /^snapshot_/.test(image) ? image : base(image, signal);
  }

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    const found = await call(morph => morph.instances.list(wanted.length ? { metadata: filter.labels } : {}), filter.signal);
    // Morph filters already; checking again keeps `list` exact whatever the server matches.
    return found.map(item => info(item)).filter(item => wanted.every(([key, value]) => item.labels[key] === value));
  }

  /** The command as one `sh -c` script with its environment and directory, so quotes and `exit` behave. */
  function script(command: string, execOptions: ExecOptions) {
    const env = Object.entries(execOptions.env ?? {});
    for (const [key] of env)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new SandboxError("rejected", name, { code: "invalid_env_name" });
    const prefix = [...env.map(([key, value]) => `export ${key}=${quote(value)}`), ...(execOptions.cwd ? [`cd ${quote(execOptions.cwd)}`] : [])];
    return `sh -c ${quote(prefix.length ? `${prefix.join(" && ")} && ${command}` : command)}`;
  }

  async function run(id: string, command: string, execOptions: ExecOptions = {}) {
    const full = script(command, execOptions);
    const seconds = Math.max(1, Math.ceil((execOptions.timeoutMs ?? 600_000) / 1000));
    const target = await instance(id, execOptions.signal);
    const result = await call(() => target.exec(full, { timeout: seconds }), execOptions.signal, seconds * 1000 + 15_000);
    return { exitCode: result.exit_code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /** Runs a helper script that must succeed (file transfer, background start). */
  async function must(id: string, command: string, code: string, signal?: AbortSignal) {
    const result = await run(id, command, { signal, timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new SandboxError("rejected", name, { code });
    return result;
  }

  return defineProvider({
    name,
    capabilities: ["pause", "snapshot", "ttl", "ports", "background", "persistentDisk"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const key = createOptions.idempotencyKey;
      const labels = { ...createOptions.labels, ...(key ? { [IDEMPOTENCY_LABEL]: key } : {}) };
      if (key) {
        const existing = (await list({ labels: { [IDEMPOTENCY_LABEL]: key }, signal }))[0];
        if (existing) return existing;
      }
      const snapshotId = await resolve(createOptions.image, signal);
      const ttl = options.ttlSeconds ? { ttlSeconds: options.ttlSeconds, ttlAction } : {};
      // `start` waits for the instance to be ready and deletes it if it fails to get there.
      const started = await call(morph => morph.instances.start({ snapshotId, metadata: labels, ...ttl, timeout: SLOW }),
        signal, (SLOW + 60) * 1000);
      instances.set(started.id, started);
      return info(started, labels);
    },

    async get(id, callOptions = {}) {
      try {
        return info(await call(morph => morph.instances.get({ instanceId: id }), callOptions.signal));
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },

    list,

    /** Deleting an instance that is already gone is not an error. */
    async destroy(id, callOptions = {}) {
      instances.delete(id);
      try {
        await call(morph => morph.instances.stop({ instanceId: id }), callOptions.signal);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    exec: run,

    async readFile(id, path, callOptions = {}) {
      const result = await run(id, `[ -f ${quote(path)} ] || exit 44; base64 < ${quote(path)}`, { signal: callOptions.signal, timeoutMs: 120_000 });
      if (result.exitCode === 44) throw new SandboxError("not_found", name, { code: "file_not_found" });
      if (result.exitCode !== 0) throw new SandboxError("rejected", name, { code: "read_failed" });
      return new Uint8Array(Buffer.from(result.stdout, "base64"));
    },

    /** Written to a temporary file in chunks, then moved into place, so readers never see half a file. */
    async writeFile(id, path, data, callOptions = {}) {
      const encoded = Buffer.from(typeof data === "string" ? Buffer.from(data) : data).toString("base64");
      const temporary = quote(`${path}.open-sb-${randomUUID()}`);
      const directory = path.slice(0, path.lastIndexOf("/"));
      const chunks: string[] = [];
      for (let at = 0; at < encoded.length || chunks.length === 0; at += CHUNK) chunks.push(encoded.slice(at, at + CHUNK));
      try {
        for (const [index, chunk] of chunks.entries()) {
          const steps = [
            ...(index === 0 && directory ? [`mkdir -p ${quote(directory)}`] : []),
            `printf %s '${chunk}' | base64 -d ${index === 0 ? ">" : ">>"} ${temporary}`,
            ...(index === chunks.length - 1 ? [`mv -f ${temporary} ${quote(path)}`] : []),
          ];
          await must(id, steps.join(" && "), "write_failed", callOptions.signal);
        }
      } catch (error) {
        await run(id, `rm -f ${temporary}`).catch(() => undefined);
        throw error;
      }
    },

    /** Keeps memory and disk; `resume` restores both. */
    async pause(id, callOptions = {}) {
      const target = await call(morph => morph.instances.get({ instanceId: id }), callOptions.signal);
      if (target.status === "paused") return;
      await call(() => target.pause(), callOptions.signal, SLOW * 1000);
    },

    async resume(id, callOptions = {}) {
      const target = await call(morph => morph.instances.get({ instanceId: id }), callOptions.signal);
      if (target.status === "ready") return;
      await call(() => target.resume(), callOptions.signal, SLOW * 1000);
    },

    /** The instance keeps running. Morph assigns the id; the name goes into the snapshot's metadata. */
    async snapshot(id, snapshot, callOptions = {}) {
      const target = await instance(id, callOptions.signal);
      const saved = await call(() => target.snapshot({ metadata: { [SNAPSHOT_NAME]: snapshot } }), callOptions.signal, SLOW * 1000);
      await waitForSnapshot(saved.id, callOptions.signal);
    },

    async listSnapshots(callOptions = {}) {
      const all = await call(morph => morph.snapshots.list(), callOptions.signal);
      return [...new Set(all.filter(usable).map(item => item.metadata?.[SNAPSHOT_NAME]).filter(item => item !== undefined))];
    },

    /** Deletes every snapshot with the name; a missing one is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      for (const item of await named(snapshot, callOptions.signal))
        await call(() => item.delete(), callOptions.signal).catch(error => { if (!notFound(error)) throw error; });
    },

    async setTtl(id, seconds, callOptions = {}) {
      const target = await instance(id, callOptions.signal);
      await call(() => target.setTTL(seconds, ttlAction), callOptions.signal);
    },

    /** A public `https://<name>-<instance>.http.cloud.morph.so` address; an already exposed port is reused. */
    async portUrl(id, port, callOptions = {}) {
      const target = await call(morph => morph.instances.get({ instanceId: id }), callOptions.signal);
      const existing = target.networking?.httpServices?.find(service => service.port === port);
      if (existing) return { url: existing.url };
      return { url: (await call(() => target.exposeHttpService(`port-${port}`, port), callOptions.signal)).url };
    },

    /** Detached from the exec call with `nohup` and its output discarded, so the call returns at once. */
    async startBackground(id, command, execOptions = {}) {
      const inner = script(command, { env: execOptions.env, cwd: execOptions.cwd });
      await must(id, `nohup ${inner} > /dev/null 2>&1 < /dev/null &`, "background_start_failed", execOptions.signal);
    },
  });
}
