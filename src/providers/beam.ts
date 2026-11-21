// Beam (beam.cloud): persistent CPU VMs for agents, through the official `@beamcloud/beam-js` SDK (an optional
// peer dependency). Built on the SDK's `VM` API, not its `Sandbox` class: `Sandbox` can create, connect and
// terminate a container by ID but cannot list sandboxes, report their state or store labels, so `get` and `list`
// would be impossible. A VM has all three (metadata is Beam's label map, filtered on the server), plus pause with
// RAM and disk kept, named disk snapshots, an idle timeout and protected port URLs.
//
// Sandboxes are created with `autoResume` (exec and files wake a paused VM) and `idleAction: "pause"`: after
// `ttlSeconds` without API activity Beam pauses the VM rather than deleting it. `ttl` is that idle timeout:
// activity through the API pushes `expiresAt` forward, and expiry pauses (state `stopped`), never deletes.
// Retried creates reuse the idempotency key as Beam's `requestId` (a UUID; other keys are hashed into one).
//
// Left out: `ssh` (Beam takes the public key only at creation and reaches port 2222 through an authenticated
// WebSocket tunnel that needs local OpenSSH; there is no host and port to hand out, so new sandboxes are
// created with `ssh: false`, which also stops the SDK generating a key under ~/.beam), and `desktop` (opt-in at
// creation, and its viewer is a short-lived browser session that exchanges a credential for a cookie).
//
// Limits: the SDK keeps one global configuration (`beamOpts`) and builds its HTTP client on first use, so a
// process talks to one Beam token, workspace and gateway. Most SDK calls take no AbortSignal: an abandoned call
// returns at once but may still finish on Beam. `list` has no pagination in the SDK. Images must be Debian or
// Ubuntu registry images with apt (Beam installs its VM services); the default is Beam's Ubuntu 24.04.
// Snapshots capture the disk, not RAM or running processes.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  beamOpts, Image, SandboxFileSystemError, SandboxProcessError, VM, VMError, type VMArtifact, type VMInfo, type VMStatus,
} from "@beamcloud/beam-js";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

export interface BeamOptions {
  /** Default: `BEAM_TOKEN`. */
  token?: string;
  /** Default: `BEAM_WORKSPACE_ID`, else the SDK resolves the token's current workspace. */
  workspaceId?: string;
  /** Default: the SDK's `https://app.beam.cloud`. */
  gatewayUrl?: string;
  /** Registry image for `create()` without `image` (Debian or Ubuntu). Default: Beam's Ubuntu 24.04. */
  image?: string;
  /** CPU cores or millicores (`"1000m"`). Default: Beam's 4 cores. */
  cpu?: number | string;
  /** MiB or a quantity (`"2Gi"`). Default: Beam's 8 GiB. */
  memory?: number | string;
  /** Idle seconds before Beam pauses a sandbox. Default 900; change it with `setTtl`. 0 never pauses. */
  ttlSeconds?: number;
  name?: string;
  /** Override for tests: substitutes for the SDK's `VM` and `Image` classes. */
  VM?: typeof VM;
  Image?: typeof Image;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Beam's `requestId` must be a UUID; other keys become a stable name-based (version 5 layout) UUID. */
function requestId(key: string): string {
  if (UUID.test(key)) return key.toLowerCase();
  const hex = createHash("sha256").update(key).digest("hex");
  const variant = (8 | (parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Pausing and stopping VMs still hold compute until they settle, so they read as running until then. */
const STATE: Record<VMStatus, SandboxState> = {
  starting: "starting", running: "running", pausing: "running", stopping: "running",
  paused: "stopped", stopped: "stopped", deleting: "gone", deleted: "gone", error: "gone",
};

interface AxiosLike { isAxiosError: true; code?: string; response?: { status: number; headers?: Record<string, unknown> } }
const axiosOf = (error: unknown): AxiosLike | undefined => {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause])
    if ((candidate as { isAxiosError?: unknown } | null)?.isAxiosError === true) return candidate as AxiosLike;
  return undefined;
};

export function beam(options: BeamOptions = {}) {
  const name = options.name ?? "beam";
  const ttlSeconds = options.ttlSeconds ?? 900;
  const SDK = options.VM ?? VM;
  const Images = options.Image ?? Image;
  const token = options.token ?? process.env.BEAM_TOKEN;
  const workspaceId = options.workspaceId ?? process.env.BEAM_WORKSPACE_ID;
  if (token) beamOpts.token = token;
  if (workspaceId) beamOpts.workspaceId = workspaceId;
  if (options.gatewayUrl) beamOpts.gatewayUrl = options.gatewayUrl;
  /** Resolved VMs, so exec and files skip the lookup; the SDK refreshes their state itself before guest calls. */
  const vms = new Map<string, VM>();

  /** Maps SDK failures onto SandboxError. Beam's messages can carry response bodies, so none reach ours. */
  function fail(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted) return signal.reason ?? error;
    if (error instanceof SandboxError) return error;
    const http = axiosOf(error);
    const status = (error instanceof VMError ? error.status : undefined) ?? http?.response?.status;
    if (status !== undefined) {
      const retryAfter = Number(http?.response?.headers?.["retry-after"]);
      return httpError(name, status, undefined, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    // No HTTP answer: a request timeout, or the network between us and Beam.
    if (http) return http.code === "ECONNABORTED" || http.code === "ETIMEDOUT"
      ? new SandboxError("timeout", name, { code: "request_timeout" }) : httpError(name, null, "network");
    if (error instanceof VMError) {
      // Checks the SDK makes locally: readiness or process deadlines, a VM that is not running, bad options.
      if (/timeout/i.test(error.message)) return new SandboxError("timeout", name, { code: "timeout" });
      if (/^VM is \w+/.test(error.message)) return new SandboxError("rejected", name, { code: "not_running" });
      return new SandboxError("rejected", name, { code: "vm_error" });
    }
    // The sandbox runtime answered `ok: false`; only the kind is kept.
    if (error instanceof SandboxFileSystemError)
      return /no such file|not found|does not exist/i.test(error.message)
        ? new SandboxError("not_found", name, { code: "file_not_found" }) : new SandboxError("rejected", name, { code: "filesystem_error" });
    if (error instanceof SandboxProcessError) return new SandboxError("rejected", name, { code: "process_error" });
    if (error instanceof Error && /^Beam (token|gateway URL|workspace ID) is not set$/.test(error.message))
      return new SandboxError("rejected", name, { code: "not_configured" });
    return error;
  }

  /** Runs SDK work under a deadline and the caller's signal, since most SDK calls take neither. */
  async function call<T>(work: () => Promise<T>, signal?: AbortSignal, timeoutMs = 120_000): Promise<T> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.aborted ? signal.reason : new SandboxError("timeout", name, { code: "request_timeout" }));
      stop.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work(), aborted]);
    } catch (error) {
      throw fail(error, signal);
    } finally {
      stop.removeEventListener("abort", onAbort);
    }
  }

  async function machine(id: string): Promise<VM> {
    let vm = vms.get(id);
    if (!vm) vms.set(id, vm = await SDK.get(id));
    return vm;
  }

  const describe = (vm: VMInfo): SandboxInfo => {
    const idle = vm.spec?.idleTimeout ?? 0;
    const lastActive = Date.parse(vm.lastActiveAt);
    return {
      id: vm.id,
      state: STATE[vm.status] ?? "starting",
      labels: { ...vm.metadata },
      createdAt: vm.createdAt ? new Date(vm.createdAt) : undefined,
      // Only a running VM is counting down; activity moves this forward.
      expiresAt: vm.status === "running" && idle > 0 && Number.isFinite(lastActive) ? new Date(lastActive + idle * 1000) : undefined,
    };
  };

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    const found = await call(() => SDK.list({ all: true, ...(wanted.length ? { metadata: filter.labels } : {}) }), filter.signal);
    // Beam filters on the server; checking again keeps `list` exact whatever it matches.
    return found.map(vm => describe(vm.info))
      .filter(sandbox => sandbox.state !== "gone" && wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  /** A snapshot name (or ID) starts from that disk; anything else is a registry image. */
  async function seed(image: string | undefined): Promise<{ image?: Image; snapshot?: string }> {
    if (!image) return options.image ? { image: Images.fromRegistry(options.image) } : {};
    const snapshot = (await SDK.snapshots.list()).find(artifact => artifact.name === image || artifact.id === image);
    return snapshot ? { snapshot: snapshot.id } : { image: Images.fromRegistry(image) };
  }

  async function exec(id: string, command: string, execOptions: ExecOptions = {}) {
    const { signal } = execOptions;
    const timeoutMs = execOptions.timeoutMs ?? 600_000;
    return call(async () => {
      const vm = await machine(id);
      // `wait` lets Beam return a short command's output inline. Without `cwd` Beam starts in /workspace.
      const child = await vm.execShell(command, { env: execOptions.env, wait: true, ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}) });
      try {
        const exitCode = await child.wait({ timeoutMs, signal });
        const [stdout, stderr] = await Promise.all([child.stdout.read(), child.stderr.read()]);
        return { exitCode, stdout, stderr };
      } catch (error) {
        // A wait that ends early leaves the process running; stop it.
        await child.kill().catch(() => undefined);
        if (!signal?.aborted && error instanceof VMError && error.status === undefined && /did not exit/.test(error.message))
          throw new SandboxError("timeout", name, { code: "exec_timeout" });
        throw error;
      }
    }, signal, timeoutMs + 60_000);
  }

  /** Every snapshot carrying `snapshot` as its name. */
  const named = async (snapshot: string): Promise<VMArtifact[]> =>
    (await SDK.snapshots.list()).filter(artifact => artifact.name === snapshot);

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "snapshot", "ttl", "ports", "background"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const labels = { ...createOptions.labels };
      const vm = await call(async () => SDK.create({
        ...(await seed(createOptions.image)), metadata: labels, ssh: false,
        idleTimeout: ttlSeconds, idleAction: "pause", autoResume: true,
        ...(options.cpu !== undefined ? { cpu: options.cpu } : {}), ...(options.memory !== undefined ? { memory: options.memory } : {}),
        ...(createOptions.idempotencyKey ? { requestId: requestId(createOptions.idempotencyKey) } : {}),
      }, { signal, timeoutMs: 600_000 }), signal, 660_000);
      vms.set(vm.id, vm);
      return describe(vm.info);
    },

    async get(id, callOptions = {}) {
      try {
        const vm = await call(() => SDK.get(id), callOptions.signal);
        vms.set(id, vm);
        return describe(vm.info);
      } catch (error) {
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    list,

    /** Deletes the VM and its disk. Destroying a missing or deleted sandbox is not an error. */
    async destroy(id, callOptions = {}) {
      vms.delete(id);
      try {
        await call(async () => {
          const vm = await SDK.get(id);
          if (vm.status !== "deleting" && vm.status !== "deleted") await vm.remove();
        }, callOptions.signal);
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    exec,

    async readFile(id, path, callOptions = {}) {
      const bytes = await call(async () => (await machine(id)).fs.readBytes(path), callOptions.signal, 300_000);
      // The SDK returns a Buffer; callers get a plain Uint8Array.
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    },

    async writeFile(id, path, data, callOptions = {}) {
      const { signal } = callOptions;
      await call(async () => {
        const vm = await machine(id);
        try {
          await vm.fs.writeBytes(path, data);
        } catch (error) {
          // Beam does not create parent directories: make them and try once more.
          if (!(error instanceof SandboxFileSystemError)) throw error;
          const mkdir = await vm.exec(["mkdir", "-p", "--", posix.dirname(path)], { cwd: "/", wait: true });
          if (await mkdir.wait({ timeoutMs: 30_000, signal }) !== 0) throw error;
          await vm.fs.writeBytes(path, data);
        }
      }, signal, 300_000);
    },

    /** Keeps RAM, running processes and disk; `resume` restores them. */
    async pause(id, callOptions = {}) {
      await call(async () => { await (await machine(id)).pause(); }, callOptions.signal);
    },

    async resume(id, callOptions = {}) {
      const { signal } = callOptions;
      await call(async () => { await (await machine(id)).resume({ signal, timeoutMs: 300_000 }); }, signal, 330_000);
    },

    /** A disk snapshot (no RAM), kept until `deleteSnapshot`, even after the sandbox is destroyed. */
    async snapshot(id, snapshot, callOptions = {}) {
      await call(async () => {
        // Names must pick one snapshot for `create({ image })`.
        if ((await named(snapshot)).length) throw new SandboxError("rejected", name, { code: "snapshot_exists" });
        await (await machine(id)).snapshots.create({ name: snapshot });
      }, callOptions.signal, 600_000);
    },

    async listSnapshots(callOptions = {}) {
      return call(async () => [...new Set((await SDK.snapshots.list()).map(artifact => artifact.name).filter(Boolean))], callOptions.signal);
    },

    /** Deleting a missing snapshot is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      await call(async () => {
        for (const artifact of await named(snapshot))
          await artifact.delete().catch(error => { if (!(error instanceof VMError && error.status === 404)) throw error; });
      }, callOptions.signal);
    },

    /** Sets the idle timeout: Beam pauses the sandbox after this many seconds without API activity. */
    async setTtl(id, seconds, callOptions = {}) {
      await call(async () => { await (await machine(id)).update({ idleTimeout: Math.max(0, Math.ceil(seconds)) }); }, callOptions.signal);
    },

    /** A protected URL: requests need the returned `X-Beam-VM-Token` header, a credential to keep server-side. */
    async portUrl(id, port, callOptions = {}) {
      return call(async () => {
        const vm = await machine(id);
        const url = (await vm.listUrls())[port] ?? await vm.exposePort(port, { protected: true });
        if (!url?.startsWith("https://")) throw new SandboxError("unavailable", name, { code: "port_url_not_https" });
        return { url, headers: { "X-Beam-VM-Token": await vm.getAccessToken() } };
      }, callOptions.signal);
    },

    /** Starts the command and returns once it runs. It keeps running until the sandbox pauses or stops. */
    async startBackground(id, command, execOptions = {}) {
      await call(async () => {
        await (await machine(id)).execShell(command, { env: execOptions.env, ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}) });
      }, execOptions.signal);
    },
  });
}
