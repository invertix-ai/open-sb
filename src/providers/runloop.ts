// Runloop (runloop.ai): microVM devboxes for agents. Suspend saves the disk and resume restores it (processes
// do not survive), named disk snapshots start new devboxes, and one tunnel per devbox serves every port at
// `https://{port}-{key}.tunnel.runloop.ai`, opened here in authenticated mode so URLs need the returned header.
// Uses the official `@runloop/api-client` (a peer dependency); its requests take an AbortSignal.
// Left out: `ssh` (Runloop only issues its own private key for a devbox, it takes no caller public key);
// `ttl` (`keep_alive_time_seconds` is a wall-clock lifetime fixed at creation, after which the devbox shuts
// down for good, and nothing changes it later: set it once through `launchParameters`); `desktop`.
// Devboxes have no label filter and names are not unique, so labels live in metadata, `list` pages through
// every devbox of the account (shut-down ones included, reported `gone`), and idempotency is a label lookup.
import { createHash } from "node:crypto";
import {
  APIConnectionError, APIConnectionTimeoutError, APIError, Runloop, RunloopError, toFile,
} from "@runloop/api-client";
import type {
  DevboxAsyncExecutionDetailView, DevboxCreateParams, DevboxSnapshotView, DevboxUploadFileParams, DevboxView, TunnelView,
} from "@runloop/api-client/resources/devboxes/devboxes";
import type { LaunchParameters } from "@runloop/api-client/resources/shared";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

/** Per-request options the SDK accepts. */
interface RequestOptions { signal?: AbortSignal; timeout?: number; maxRetries?: number; idempotencyKey?: string }

/** The parts of the Runloop client this provider uses; `new Runloop()` satisfies it, and tests pass a fake. */
export interface RunloopClient {
  baseURL: string;
  devboxes: {
    create(body: DevboxCreateParams, options?: RequestOptions): Promise<DevboxView>;
    retrieve(id: string, options?: RequestOptions): Promise<DevboxView>;
    list(query: { limit?: number }, options?: RequestOptions): AsyncIterable<DevboxView>;
    shutdown(id: string, params: { force?: string }, options?: RequestOptions): Promise<DevboxView>;
    suspend(id: string, options?: RequestOptions): Promise<DevboxView>;
    resume(id: string, options?: RequestOptions): Promise<DevboxView>;
    execute(id: string, params: { command: string; optimistic_timeout?: number | null }, options?: RequestOptions): Promise<DevboxAsyncExecutionDetailView>;
    waitForCommand(id: string, executionId: string, params: { statuses: Array<"queued" | "running" | "completed">; timeout_seconds?: number | null },
      options?: RequestOptions): Promise<DevboxAsyncExecutionDetailView>;
    executeAsync(id: string, body: { command: string }, options?: RequestOptions): Promise<DevboxAsyncExecutionDetailView>;
    downloadFile(id: string, body: { path: string }, options?: RequestOptions): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
    uploadFile(id: string, body: DevboxUploadFileParams, options?: RequestOptions): Promise<unknown>;
    enableTunnel(id: string, body: { auth_mode?: "open" | "authenticated" | null }, options?: RequestOptions): Promise<TunnelView>;
    snapshotDiskAsync(id: string, body: { name?: string | null; metadata?: Labels | null }, options?: RequestOptions): Promise<DevboxSnapshotView>;
    listDiskSnapshots(query: { limit?: number }, options?: RequestOptions): AsyncIterable<DevboxSnapshotView>;
    deleteDiskSnapshot(id: string, options?: RequestOptions): Promise<unknown>;
    diskSnapshots: { queryStatus(id: string, options?: RequestOptions): Promise<{ status: "in_progress" | "error" | "complete" | "deleted" }> };
    executions: {
      kill(id: string, executionId: string, body: { kill_process_group?: boolean | null }, options?: RequestOptions): Promise<unknown>;
      streamStdoutUpdates(id: string, executionId: string, query?: { offset?: string }, options?: RequestOptions): Promise<AsyncIterable<{ output: string }>>;
      streamStderrUpdates(id: string, executionId: string, query?: { offset?: string }, options?: RequestOptions): Promise<AsyncIterable<{ output: string }>>;
    };
  };
}

export interface RunloopOptions {
  /** Default: the SDK reads `RUNLOOP_API_KEY`. */
  apiKey?: string;
  /** Default: `RUNLOOP_BASE_URL`, else `https://api.runloop.ai`. */
  baseUrl?: string;
  /** Blueprint name for new devboxes when `create` names no image. Default: Runloop's default image. */
  blueprint?: string;
  /** Resources, lifetime (`keep_alive_time_seconds`, default 1 hour) and idle policy of new devboxes. */
  launchParameters?: LaunchParameters;
  /** SDK retries per request (429, 5xx, network). Default: the SDK's. */
  maxRetries?: number;
  /** A configured client; replaces `apiKey`, `baseUrl` and `maxRetries`. */
  client?: RunloopClient;
  name?: string;
}

const STATES: Record<DevboxView["status"], SandboxState> = {
  scheduled: "starting", queued: "starting", provisioning: "starting", initializing: "starting", resuming: "starting",
  running: "running", suspending: "stopped", suspended: "stopped", failure: "gone", shutdown: "gone",
};
const IDEMPOTENCY_LABEL = "open-sb.idempotency-key";
const SNAPSHOT_LABEL = "open-sb.snapshot";
/** Milliseconds Runloop may take to snapshot a disk. */
const SLOW = 600_000;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** The command as one `sh -c` script with its environment and directory, run from Runloop's login shell. */
function script(command: string, options: ExecOptions) {
  const env = Object.entries(options.env ?? {});
  for (const [key] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  const prefix = [...env.map(([key, value]) => `export ${key}=${quote(value)}`), ...(options.cwd ? [`cd ${quote(options.cwd)}`] : [])];
  return `sh -c ${quote(prefix.length ? `${prefix.join(" && ")} && ${command}` : command)}`;
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
});

export function runloop(options: RunloopOptions = {}) {
  const name = options.name ?? "runloop";
  let sdk = options.client;
  const client = (): RunloopClient => sdk ??= new Runloop({
    ...(options.apiKey ? { bearerToken: options.apiKey } : {}), baseURL: options.baseUrl, maxRetries: options.maxRetries,
  }) satisfies RunloopClient;

  /** Maps SDK failures onto SandboxError (Runloop's messages and bodies never reach ours) and bounds each call. */
  async function call<T>(work: (runloop: RunloopClient, request: RequestOptions) => Promise<T>, signal?: AbortSignal, timeoutMs = 60_000,
    extra: Omit<RequestOptions, "signal"> = {}): Promise<T> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await work(client(), { timeout: timeoutMs, ...extra, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof SandboxError) throw error;
      if (timeout.aborted || error instanceof APIConnectionTimeoutError) throw new SandboxError("timeout", name, { code: "request_timeout" });
      // Before APIError, its parent: no response at all.
      if (error instanceof APIConnectionError) throw httpError(name, null, "network");
      if (error instanceof APIError && typeof error.status === "number") {
        const retry = Number.parseInt(String(error.headers?.["retry-after"] ?? ""), 10);
        throw httpError(name, error.status, undefined, Number.isFinite(retry) && retry > 0 ? retry : undefined);
      }
      if (error instanceof RunloopError) throw new SandboxError("rejected", name, { code: "sdk_error" });
      if (error instanceof TypeError) throw httpError(name, null, "network");
      throw error;
    }
  }

  const notFound = (error: unknown) => error instanceof SandboxError && error.kind === "not_found";

  const info = (devbox: DevboxView): SandboxInfo => {
    const { [IDEMPOTENCY_LABEL]: _key, ...labels } = devbox.metadata ?? {};
    return { id: devbox.id, state: STATES[devbox.status] ?? "starting", labels,
      createdAt: devbox.create_time_ms ? new Date(devbox.create_time_ms) : undefined };
  };

  async function devboxes(signal?: AbortSignal): Promise<DevboxView[]> {
    return call(async (runloop, request) => {
      const found: DevboxView[] = [];
      // The SDK follows Runloop's cursor across pages with the same request options.
      for await (const devbox of runloop.devboxes.list({ limit: 100 }, request)) found.push(devbox);
      return found;
    }, signal, 300_000);
  }

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    return (await devboxes(filter.signal)).filter(devbox => wanted.every(([key, value]) => devbox.metadata?.[key] === value)).map(info);
  }

  async function snapshots(signal?: AbortSignal): Promise<DevboxSnapshotView[]> {
    return call(async (runloop, request) => {
      const found: DevboxSnapshotView[] = [];
      for await (const snapshot of runloop.devboxes.listDiskSnapshots({ limit: 100 }, request)) found.push(snapshot);
      return found;
    }, signal, 300_000);
  }

  /** A named snapshot (newest first) or snapshot ID becomes `snapshot_id`; anything else is a blueprint name. */
  async function source(image: string | undefined, signal?: AbortSignal): Promise<Partial<DevboxCreateParams>> {
    if (!image) return options.blueprint ? { blueprint_name: options.blueprint } : {};
    const match = (await snapshots(signal)).filter(snapshot => snapshot.name === image || snapshot.id === image)
      .sort((a, b) => b.create_time_ms - a.create_time_ms)[0];
    return match ? { snapshot_id: match.id } : { blueprint_name: image };
  }

  /** Reads the rest of an output Runloop cut short, from the execution's log stream. */
  async function output(id: string, executionId: string, which: "stdout" | "stderr", signal?: AbortSignal) {
    return call(async (runloop, request) => {
      const stream = which === "stdout" ? await runloop.devboxes.executions.streamStdoutUpdates(id, executionId, {}, request)
        : await runloop.devboxes.executions.streamStderrUpdates(id, executionId, {}, request);
      let text = "";
      for await (const chunk of stream) text += chunk.output;
      return text;
    }, signal, 300_000);
  }

  async function exec(id: string, command: string, execOptions: ExecOptions = {}) {
    const { signal } = execOptions;
    const full = script(command, execOptions);
    const deadline = Date.now() + (execOptions.timeoutMs ?? 600_000);
    const seconds = () => Math.max(1, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    // Runloop waits up to 25 s per request; longer commands are waited on again until they finish.
    let execution = await call((runloop, request) => runloop.devboxes.execute(id, { command: full, optimistic_timeout: seconds() }, request),
      signal, 90_000, { maxRetries: 0 });
    while (execution.status !== "completed") {
      if (Date.now() >= deadline) {
        await call((runloop, request) => runloop.devboxes.executions.kill(id, execution.execution_id, { kill_process_group: true }, request))
          .catch(() => undefined);
        throw new SandboxError("timeout", name, { code: "exec_timeout" });
      }
      const current = execution;
      try {
        execution = await call((runloop, request) => runloop.devboxes.waitForCommand(id, current.execution_id,
          { statuses: ["completed"], timeout_seconds: seconds() }, request), signal, 90_000, { maxRetries: 0 });
      } catch (error) {
        // 408: still running when Runloop stopped waiting.
        if (!(error instanceof SandboxError && error.status === 408)) throw error;
      }
    }
    const stdout = execution.stdout_truncated ? await output(id, execution.execution_id, "stdout", signal) : execution.stdout ?? "";
    const stderr = execution.stderr_truncated ? await output(id, execution.execution_id, "stderr", signal) : execution.stderr ?? "";
    return { exitCode: execution.exit_status ?? 128, stdout, stderr };
  }

  async function upload(id: string, path: string, bytes: Buffer, signal?: AbortSignal) {
    const file = await toFile(bytes, path.slice(path.lastIndexOf("/") + 1) || "file");
    await call((runloop, request) => runloop.devboxes.uploadFile(id, { path, file }, request), signal, SLOW);
  }

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "snapshot", "ports", "background"] as const,

    async create(createOptions = {}) {
      const { signal, idempotencyKey } = createOptions;
      const labels: Labels = { ...createOptions.labels };
      if (idempotencyKey) {
        // No native idempotency: a retried create finds the devbox the first attempt labelled with the key.
        labels[IDEMPOTENCY_LABEL] = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
        const existing = (await devboxes(signal)).find(devbox => devbox.metadata?.[IDEMPOTENCY_LABEL] === labels[IDEMPOTENCY_LABEL]
          && STATES[devbox.status] !== "gone");
        if (existing) return info(existing);
      }
      const body: DevboxCreateParams = { metadata: labels, ...(await source(createOptions.image, signal)),
        ...(options.launchParameters ? { launch_parameters: options.launchParameters } : {}) };
      // Returns at once, still provisioning.
      return info(await call((runloop, request) => runloop.devboxes.create(body, request), signal, 120_000,
        idempotencyKey ? { idempotencyKey: labels[IDEMPOTENCY_LABEL] } : {}));
    },

    async get(id, callOptions = {}) {
      try {
        return info(await call((runloop, request) => runloop.devboxes.retrieve(id, request), callOptions.signal));
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },

    list,

    /** Shutdown is final; a devbox already shut down or failed is left as it is. */
    async destroy(id, callOptions = {}) {
      const { signal } = callOptions;
      try {
        const devbox = await call((runloop, request) => runloop.devboxes.retrieve(id, request), signal);
        if (STATES[devbox.status] === "gone") return;
        // `force` also ends a devbox with a snapshot in progress.
        await call((runloop, request) => runloop.devboxes.shutdown(id, { force: "true" }, request), signal);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    exec,

    async readFile(id, path, callOptions = {}) {
      const response = await call((runloop, request) => runloop.devboxes.downloadFile(id, { path }, request), callOptions.signal, SLOW);
      return new Uint8Array(await call(() => response.arrayBuffer(), callOptions.signal, SLOW));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const { signal } = callOptions;
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const directory = path.slice(0, path.lastIndexOf("/"));
      try {
        await upload(id, path, bytes, signal);
      } catch (error) {
        // The upload may not create parent folders: create them and try once more.
        if (!directory || !(error instanceof SandboxError) || (error.kind !== "rejected" && error.kind !== "not_found")) throw error;
        const made = await exec(id, `mkdir -p ${quote(directory)}`, { signal, timeoutMs: 60_000 });
        if (made.exitCode !== 0) throw error;
        await upload(id, path, bytes, signal);
      }
    },

    /** Suspend saves the disk (not memory: processes end); resume boots from it. */
    async pause(id, callOptions = {}) {
      const devbox = await call((runloop, request) => runloop.devboxes.retrieve(id, request), callOptions.signal);
      if (STATES[devbox.status] === "stopped") return;
      await call((runloop, request) => runloop.devboxes.suspend(id, request), callOptions.signal, 300_000);
    },

    async resume(id, callOptions = {}) {
      const devbox = await call((runloop, request) => runloop.devboxes.retrieve(id, request), callOptions.signal);
      if (devbox.status === "running" || devbox.status === "resuming") return;
      await call((runloop, request) => runloop.devboxes.resume(id, request), callOptions.signal, 300_000);
    },

    /** A named disk snapshot. Runloop does not keep names unique, so a name already taken is refused. */
    async snapshot(id, snapshot, callOptions = {}) {
      const { signal } = callOptions;
      if ((await snapshots(signal)).some(existing => existing.name === snapshot))
        throw new SandboxError("rejected", name, { code: "snapshot_exists" });
      const started = await call((runloop, request) => runloop.devboxes.snapshotDiskAsync(id,
        { name: snapshot, metadata: { [SNAPSHOT_LABEL]: snapshot } }, request), signal);
      const until = Date.now() + SLOW;
      for (;;) {
        const { status } = await call((runloop, request) => runloop.devboxes.diskSnapshots.queryStatus(started.id, request), signal);
        if (status === "complete") return;
        if (status === "error" || status === "deleted") throw new SandboxError("unavailable", name, { code: "snapshot_failed" });
        if (Date.now() > until) throw new SandboxError("timeout", name, { code: "snapshot_timeout" });
        await sleep(2_000, signal);
      }
    },

    /** Every named disk snapshot of the account; unnamed ones (such as those taken by suspend) are left out. */
    async listSnapshots(callOptions = {}) {
      return [...new Set((await snapshots(callOptions.signal)).flatMap(snapshot => snapshot.name ? [snapshot.name] : []))];
    },

    /** Deletes every snapshot with this name; a missing one is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      const { signal } = callOptions;
      for (const found of (await snapshots(signal)).filter(existing => existing.name === snapshot))
        await call((runloop, request) => runloop.devboxes.deleteDiskSnapshot(found.id, request), signal).catch(error => {
          if (!notFound(error)) throw error;
        });
    },

    /**
     * The devbox's tunnel URL for the port. A devbox without a tunnel gets an authenticated one, whose bearer
     * token is returned as a header: keep both server-side. A tunnel opened elsewhere in open mode needs none.
     */
    async portUrl(id, port, callOptions = {}) {
      const { signal } = callOptions;
      const runloop = client();
      let tunnel = (await call((rl, request) => rl.devboxes.retrieve(id, request), signal)).tunnel;
      if (!tunnel) {
        try {
          tunnel = await call((rl, request) => rl.devboxes.enableTunnel(id, { auth_mode: "authenticated" }, request), signal);
        } catch (error) {
          // A concurrent call enabled it first.
          tunnel = (await call((rl, request) => rl.devboxes.retrieve(id, request), signal)).tunnel;
          if (!tunnel) throw error;
        }
      }
      // As the SDK builds it: the API host without its `api.` prefix.
      const host = new URL(runloop.baseURL).hostname.replace(/^api\./, "");
      const url = `https://${port}-${tunnel.tunnel_key}.tunnel.${host}`;
      return tunnel.auth_token ? { url, headers: { "X-Runloop-Tunnel-Authorization": `Bearer ${tunnel.auth_token}` } } : { url };
    },

    /** An asynchronous execution: it runs until it ends or the devbox stops. */
    async startBackground(id, command, execOptions = {}) {
      const full = script(command, execOptions);
      await call((runloop, request) => runloop.devboxes.executeAsync(id, { command: full }, request), execOptions.signal);
    },
  });
}
