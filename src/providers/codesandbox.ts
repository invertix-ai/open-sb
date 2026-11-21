// CodeSandbox SDK (codesandbox.io/sdk): Firecracker microVMs forked from templates. Hibernation keeps memory and
// disk and resumes in seconds; ports are served on `https://<id>-<port>.csb.app`. Uses the official
// `@codesandbox/sdk` (a peer dependency), whose control API (create, hibernate, resume, delete, list by tags) is
// HTTP and whose commands and files go over a websocket session to the VM's agent.
// - Labels are tags `key=value` (both URI-encoded). CodeSandbox allows 10 tags and adds `sdk` itself, so a sandbox
//   takes at most 8 labels (9 without an idempotency key). Idempotency is a tag looked up before creating.
// - State has no field in the API: `running` means the VM sent a heartbeat in the last ~30 s (CodeSandbox's running
//   list), anything else is `stopped`. Changes made from this process show at once; others can lag ~30 s.
// - Commands run in a terminal that merges stdout and stderr, so exec redirects both to files and reads them back.
// - Snapshots are hibernated forks: `snapshot` forks the sandbox (CodeSandbox copies its memory and disk), tags the
//   fork with the name and hibernates it; `create({ image: name })` forks that. Each snapshot is a full sandbox in
//   the workspace (it costs storage, not VM time) and `list` hides it. An `image` that names no snapshot is passed
//   on as a template or sandbox ID.
// Left out: `ttl` (the hibernation timeout is an idle timer, not a deadline), `ssh` and `desktop` (not offered).
// Sessions are cached per sandbox and closed after `sessionIdleMs` so the process can exit.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { CodeSandbox } from "@codesandbox/sdk";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

/** The parts of a connected session this provider uses; the SDK's `SandboxClient` satisfies it. */
export interface CsbSession {
  readonly state: string;
  commands: {
    runBackground(command: string): Promise<{ waitUntilComplete(): Promise<string>; kill(): Promise<void> }>;
    run(command: string): Promise<string>;
  };
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: Uint8Array): Promise<void>;
    mkdir(path: string, recursive?: boolean): Promise<void>;
    remove(path: string, recursive?: boolean): Promise<void>;
  };
  dispose(): void;
}

interface CsbSandboxInfo { id: string; createdAt: Date; tags: string[] }

/** What `create` passes on. The SDK's own option types do not resolve under `nodenext`, so they are restated. */
export interface CsbCreateOptions {
  id?: string;
  tags?: string[];
  privacy?: "public-hosts" | "private";
  title?: string;
  vmTier?: { readonly name: string };
  hibernationTimeoutSeconds?: number;
}

/** The SDK's `CommandError` (a nonzero exit), recognised by shape: its export is invisible to the type checker. */
const commandExit = (error: unknown): number | undefined =>
  error instanceof Error && error.name === "CommandError" && typeof (error as { exitCode?: unknown }).exitCode === "number"
    ? (error as unknown as { exitCode: number }).exitCode : undefined;

/** The parts of the SDK client this provider uses; `new CodeSandbox()` satisfies it, and tests pass a fake. */
export interface CsbClient {
  sandboxes: {
    create(opts: CsbCreateOptions): Promise<{ id: string }>;
    resume(id: string): Promise<{ connect(): Promise<CsbSession> }>;
    hibernate(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    get(id: string): Promise<CsbSandboxInfo>;
    list(opts: { tags?: string[]; limit?: number; pagination?: { page?: number; pageSize?: number } }):
      Promise<{ sandboxes: CsbSandboxInfo[]; pagination: { nextPage: number | null } }>;
    listRunning(): Promise<{ vms: { id: string | undefined }[] }>;
  };
  hosts: { createToken(sandboxId: string, opts: { expiresAt: Date }): Promise<{ token: string }> };
}

export interface CodeSandboxOptions {
  /** Default: the `CSB_API_KEY` environment variable, as the SDK reads it. */
  apiKey?: string;
  /** API address. Default: the SDK's, from `CSB_BASE_URL` or the key. */
  baseUrl?: string;
  /** Template (or sandbox) ID forked when `create` names no image. Default: CodeSandbox's universal template. */
  template?: string;
  /** VM size for new sandboxes, for example `VMTier.Micro`. Default: the workspace's. */
  vmTier?: { readonly name: string };
  /** Idle seconds before CodeSandbox hibernates a sandbox on its own. Default: CodeSandbox's (300 s on free plans). */
  hibernationTimeoutSeconds?: number;
  /** Ports answer only with a host token, returned by `portUrl` as a header. Default false: ports are public. */
  privatePorts?: boolean;
  /** Lifetime of the host tokens `portUrl` creates for private ports. Default 3600 s. */
  portTokenSeconds?: number;
  /** Idle milliseconds before a cached session is closed. Default 10 000. */
  sessionIdleMs?: number;
  /** Fetch used for API calls (instrumentation, tests). Default: the global fetch. */
  fetch?: typeof fetch;
  /** A configured client; replaces `apiKey`, `baseUrl` and `fetch`. Errors then map without HTTP statuses. */
  client?: CsbClient;
  name?: string;
}

const IDEMPOTENCY_TAG = "open-sb.idempotency";
const SNAPSHOT_TAG = "open-sb.snapshot";
const SNAPSHOT_NAME_TAG = "open-sb.snapshot-name";
const MAX_TAGS = 10;
/** How long a state this process set wins over CodeSandbox's running list, which lags by up to 30 s. */
const LOCAL_STATE_MS = 45_000;

const tag = (key: string, value: string) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
function labelsOf(tags: readonly string[]): Labels {
  const labels: Labels = {};
  for (const entry of tags) {
    const split = entry.indexOf("=");
    if (split < 1) continue;
    try {
      labels[decodeURIComponent(entry.slice(0, split))] = decodeURIComponent(entry.slice(split + 1));
    } catch { /* a tag someone else wrote, not ours */ }
  }
  return labels;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** `cd` and `export` steps run before the command, each joined with `&&`. */
function prefix(options: ExecOptions): string[] {
  const env = Object.entries(options.env ?? {});
  for (const [key] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  return [...(options.cwd ? [`cd ${quote(options.cwd)}`] : []), ...env.map(([key, value]) => `export ${key}=${quote(value)}`)];
}

interface Context { signal?: AbortSignal; status?: number; retryAfter?: number; network?: boolean }
interface Session { session: Promise<CsbSession>; busy: number; timer?: ReturnType<typeof setTimeout> }

export function codesandbox(options: CodeSandboxOptions = {}) {
  const name = options.name ?? "codesandbox";
  const idleMs = options.sessionIdleMs ?? 10_000;
  /** Carries the caller's signal into the SDK's fetches and brings back the HTTP status its errors leave out. */
  const context = new AsyncLocalStorage<Context>();
  const baseFetch = options.fetch ?? globalThis.fetch;
  async function recordingFetch(request: Request): Promise<Response> {
    const ctx = context.getStore();
    try {
      const response = await baseFetch(ctx?.signal ? new Request(request, { signal: ctx.signal }) : request);
      if (ctx) {
        const retry = Number(response.headers.get("retry-after"));
        Object.assign(ctx, response.ok ? { status: undefined, retryAfter: undefined, network: false }
          : { status: response.status, retryAfter: retry > 0 ? retry : undefined, network: false });
      }
      return response;
    } catch (error) {
      if (ctx) ctx.network = true;
      throw error;
    }
  }
  let sdk = options.client;
  const client = () => sdk ??= new CodeSandbox(options.apiKey, { baseUrl: options.baseUrl, fetch: recordingFetch }) satisfies CsbClient;

  const sessions = new Map<string, Session>();
  /** States this process set recently, keyed by sandbox ID. */
  const recent = new Map<string, { state: SandboxState; at: number }>();
  const remember = (id: string, state: SandboxState) => recent.set(id, { state, at: Date.now() });

  /** Maps SDK failures onto SandboxError. SDK messages embed API bodies, so none reach ours. */
  function fail(error: unknown, ctx: Context, signal?: AbortSignal): unknown {
    if (signal?.aborted) return signal.reason ?? error;
    if (error instanceof SandboxError) return error;
    if (ctx.status) return httpError(name, ctx.status, undefined, ctx.retryAfter);
    if (ctx.network) return httpError(name, null, "network");
    // Agent file errors read `<errno>: <message>`; errno 2 is ENOENT.
    const errno = error instanceof Error ? /^(-?\d+): /.exec(error.message)?.[1] : undefined;
    if (errno !== undefined)
      return Math.abs(Number(errno)) === 2 ? new SandboxError("not_found", name, { code: "file_not_found" }) : new SandboxError("rejected", name, { code: "fs_error" });
    // No status: the websocket session failed or the SDK gave up waiting on the VM.
    return new SandboxError("unavailable", name, { code: "sdk_error" });
  }

  /** Resolves with `work`, or rejects on abort or after `timeoutMs`; `onStop` runs when it gives up. */
  async function bounded<T>(work: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, onStop?: () => void): Promise<T> {
    let stop = () => {};
    const stopped = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => { onStop?.(); reject(new SandboxError("timeout", name, { code: "request_timeout" })); }, timeoutMs);
      const abort = () => { onStop?.(); reject(signal!.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    });
    try {
      return await Promise.race([work, stopped]);
    } finally {
      stop();
    }
  }

  async function call<T>(work: (csb: CsbClient) => Promise<T>, signal?: AbortSignal, timeoutMs = 120_000): Promise<T> {
    signal?.throwIfAborted();
    const ctx: Context = { signal };
    try {
      return await bounded(context.run(ctx, () => work(client())), signal, timeoutMs);
    } catch (error) {
      throw fail(error, ctx, signal);
    }
  }

  const notFound = (error: unknown) => error instanceof SandboxError && error.kind === "not_found";

  function close(id: string) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    clearTimeout(entry.timer);
    entry.session.then(session => session.dispose(), () => undefined);
  }

  /** Runs `work` on a connected session. Connecting resumes a hibernated sandbox; a dropped session is replaced. */
  async function withSession<T>(id: string, signal: AbortSignal | undefined, work: (session: CsbSession) => Promise<T>): Promise<T> {
    let entry = sessions.get(id);
    if (entry && await entry.session.then(session => session.state === "DISCONNECTED" || session.state === "HIBERNATED", () => true)) {
      close(id);
      entry = undefined;
    }
    if (!entry) {
      const session = call(async csb => (await csb.sandboxes.resume(id)).connect(), signal, 300_000);
      entry = { session, busy: 0 };
      sessions.set(id, entry);
      session.catch(() => { if (sessions.get(id) === entry) sessions.delete(id); });
      remember(id, "running");
    }
    const current = entry;
    current.busy++;
    clearTimeout(current.timer);
    try {
      return await work(await current.session);
    } finally {
      // Idle sessions close so their websocket does not keep the process alive.
      if (--current.busy === 0 && sessions.get(id) === current) {
        current.timer = setTimeout(() => close(id), idleMs);
        current.timer.unref?.();
      }
    }
  }

  /** IDs of VMs CodeSandbox saw running in the last ~30 s. */
  const running = async (signal?: AbortSignal) =>
    new Set((await call(csb => csb.sandboxes.listRunning(), signal)).vms.map(vm => vm.id).filter(id => id !== undefined));

  function info(sandbox: CsbSandboxInfo, live: Set<string>): SandboxInfo {
    const local = recent.get(sandbox.id);
    const state = local && Date.now() - local.at < LOCAL_STATE_MS ? local.state : live.has(sandbox.id) ? "running" : "stopped";
    return { id: sandbox.id, state, labels: labelsOf(sandbox.tags), createdAt: sandbox.createdAt };
  }

  /** Every sandbox carrying `tags` (one is sent to the API, all are checked here). */
  async function listTagged(tags: string[], signal?: AbortSignal): Promise<CsbSandboxInfo[]> {
    const found = new Map<string, CsbSandboxInfo>();
    for (let page: number | null = 1; page !== null;) {
      signal?.throwIfAborted();
      const result = await call(csb => csb.sandboxes.list({ ...(tags.length ? { tags: [tags[0]!] } : {}), limit: 100,
        pagination: { page: page!, pageSize: 100 } }), signal);
      for (const sandbox of result.sandboxes)
        if (tags.every(wanted => sandbox.tags.includes(wanted))) found.set(sandbox.id, sandbox);
      page = result.sandboxes.length ? result.pagination.nextPage : null;
    }
    return [...found.values()];
  }

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const tags = Object.entries(filter.labels ?? {}).map(([key, value]) => tag(key, value));
    const [found, live] = await Promise.all([listTagged(tags, filter.signal), running(filter.signal)]);
    return found.filter(sandbox => !sandbox.tags.includes(SNAPSHOT_TAG)).map(sandbox => info(sandbox, live));
  }

  /** The hibernated fork holding a snapshot, by name. */
  const snapshotSandboxes = (snapshot: string, signal?: AbortSignal) => listTagged([SNAPSHOT_TAG, tag(SNAPSHOT_NAME_TAG, snapshot)], signal);

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "snapshot", "ports", "background"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const key = createOptions.idempotencyKey;
      const keyTag = key ? tag(IDEMPOTENCY_TAG, createHash("sha256").update(key).digest("hex").slice(0, 40)) : undefined;
      const tags = [...Object.entries(createOptions.labels ?? {}).map(([k, v]) => tag(k, v)), ...(keyTag ? [keyTag] : [])];
      // CodeSandbox keeps the first ten tags and adds `sdk`: more would silently drop labels.
      if (tags.length > MAX_TAGS - 1) throw new SandboxError("rejected", name, { code: "too_many_labels" });
      // No native idempotency: a retried create finds the sandbox the first attempt tagged.
      if (keyTag) {
        const [existing] = await listTagged([keyTag], signal);
        if (existing) return info(existing, await running(signal));
      }
      const image = createOptions.image ?? options.template;
      const source = image ? (await snapshotSandboxes(image, signal))[0]?.id ?? image : undefined;
      const sandbox = await call(csb => csb.sandboxes.create({ id: source, tags, privacy: options.privatePorts ? "private" : "public-hosts",
        vmTier: options.vmTier, hibernationTimeoutSeconds: options.hibernationTimeoutSeconds }), signal, 300_000);
      remember(sandbox.id, "running");
      return { id: sandbox.id, state: "running", labels: labelsOf(tags), createdAt: new Date() };
    },

    async get(id, callOptions = {}) {
      try {
        const [sandbox, live] = await Promise.all([call(csb => csb.sandboxes.get(id), callOptions.signal), running(callOptions.signal)]);
        return info(sandbox, live);
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      close(id);
      try {
        await call(csb => csb.sandboxes.delete(id), callOptions.signal);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
      recent.delete(id);
    },

    /** stdout and stderr go to files in the VM and come back byte-exact; the terminal would merge and reformat them. */
    async exec(id, command, execOptions = {}) {
      const { signal } = execOptions;
      const dir = `/tmp/open-sb-exec-${randomUUID()}`;
      const steps = [...prefix(execOptions), `exec bash -c ${quote(command)}`];
      const script = `mkdir -p ${quote(dir)} && (${steps.join(" && ")}) >${quote(`${dir}/out`)} 2>${quote(`${dir}/err`)}`;
      return withSession(id, signal, async session => {
        const shell = await call(() => session.commands.runBackground(script), signal);
        let exitCode = 0;
        try {
          await bounded(shell.waitUntilComplete(), signal, execOptions.timeoutMs ?? 600_000, () => { shell.kill().catch(() => undefined); });
        } catch (error) {
          if (error instanceof SandboxError && error.kind === "timeout") throw new SandboxError("timeout", name, { code: "exec_timeout" });
          const code = commandExit(error);
          if (code === undefined) throw fail(error, {}, signal);
          exitCode = code;
        }
        const read = (file: string) => call(() => session.fs.readFile(`${dir}/${file}`), signal)
          .catch((error: unknown) => { if (notFound(error)) return new Uint8Array(); throw error; });
        const [stdout, stderr] = await Promise.all([read("out"), read("err")]);
        session.fs.remove(dir, true).catch(() => undefined);
        const text = new TextDecoder();
        return { exitCode, stdout: text.decode(stdout), stderr: text.decode(stderr) };
      });
    },

    async readFile(id, path, callOptions = {}) {
      return withSession(id, callOptions.signal, session => call(() => session.fs.readFile(path), callOptions.signal));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const { signal } = callOptions;
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const directory = path.slice(0, path.lastIndexOf("/"));
      await withSession(id, signal, async session => {
        // Writing does not promise to create parent folders. A failure here (often "exists") resurfaces in the write.
        if (directory) await call(() => session.fs.mkdir(directory, true), signal).catch(error => { if (signal?.aborted) throw error; });
        await call(() => session.fs.writeFile(path, bytes), signal);
      });
    },

    /** Hibernation keeps memory and disk. CodeSandbox may expire the memory snapshot; resume then boots clean from disk. */
    async pause(id, callOptions = {}) {
      close(id);
      await call(csb => csb.sandboxes.hibernate(id), callOptions.signal, 300_000);
      remember(id, "stopped");
    },

    async resume(id, callOptions = {}) {
      await call(csb => csb.sandboxes.resume(id), callOptions.signal, 300_000);
      remember(id, "running");
    },

    /** Forks the sandbox (it keeps running) into a hibernated sandbox tagged with the name, replacing an older one. */
    async snapshot(id, snapshot, callOptions = {}) {
      const { signal } = callOptions;
      const older = await snapshotSandboxes(snapshot, signal);
      const fork = await call(csb => csb.sandboxes.create({ id, tags: [SNAPSHOT_TAG, tag(SNAPSHOT_NAME_TAG, snapshot)],
        privacy: "private", title: `open-sb snapshot ${snapshot}`.slice(0, 255) }), signal, 300_000);
      await call(csb => csb.sandboxes.hibernate(fork.id), signal, 300_000);
      for (const old of older) await call(csb => csb.sandboxes.delete(old.id), signal).catch(error => { if (!notFound(error)) throw error; });
    },

    async listSnapshots(callOptions = {}) {
      const names = new Set<string>();
      for (const sandbox of await listTagged([SNAPSHOT_TAG], callOptions.signal)) {
        const snapshot = labelsOf(sandbox.tags)[SNAPSHOT_NAME_TAG];
        if (snapshot !== undefined) names.add(snapshot);
      }
      return [...names];
    },

    /** Deleting a missing snapshot is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      for (const sandbox of await snapshotSandboxes(snapshot, callOptions.signal))
        await call(csb => csb.sandboxes.delete(sandbox.id), callOptions.signal).catch(error => { if (!notFound(error)) throw error; });
    },

    /** Public by default. With `privatePorts`, a new host token comes back as a header: keep it server-side. */
    async portUrl(id, port, callOptions = {}) {
      const domain = (options.baseUrl ?? process.env.CSB_BASE_URL ?? "").includes(".stream") ? "csb.dev" : "csb.app";
      const url = `https://${id}-${port}.${domain}`;
      if (!options.privatePorts) return { url };
      const expiresAt = new Date(Date.now() + (options.portTokenSeconds ?? 3600) * 1000);
      const { token } = await call(csb => csb.hosts.createToken(id, { expiresAt }), callOptions.signal);
      return { url, headers: { "csb-preview-token": token } };
    },

    /** Detached with nohup, so it outlives the terminal that started it. */
    async startBackground(id, command, execOptions = {}) {
      const { signal } = execOptions;
      const steps = [...prefix(execOptions), `exec nohup bash -c ${quote(command)}`];
      const script = `(${steps.join(" && ")}) >/dev/null 2>&1 </dev/null &`;
      await withSession(id, signal, session => call(() => session.commands.run(script), signal));
    },
  });
}
