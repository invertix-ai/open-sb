// HOPX.AI (hopx.ai): Firecracker microVMs started from templates. Pause keeps memory and files, a timeout
// deletes the sandbox on its own (`ttl`), and every port has a public `https://{port}-{id}...` preview host.
// Uses the official `@hopx-ai/sdk` (a peer dependency), which reads `HOPX_API_KEY`.
//
// Labels: HOPX has no metadata, name or idempotency key on sandboxes, so labels are kept in a file inside the
// VM, signed with a key derived from the API key (code in the sandbox cannot forge or move them), and cached
// in this process. Reading that file needs the VM agent, so a paused sandbox this process has not seen reports
// no labels and `list({ labels })` leaves it out. Idempotency is a label lookup. Rotating the API key without
// passing the old one as `labelSecret` drops the labels of existing sandboxes.
//
// Left out: `snapshot` (templates are built from images; there is no snapshot of a running sandbox), `ssh`
// (no SSH access), `desktop` (VNC-enabled templates return a `vnc://` address for a native client, not an
// HTTPS viewer). Status `stopped` cannot be reconnected (the SDK says to create a new sandbox), so it reports
// `gone`. The SDK takes no AbortSignal and retries 5xx and network failures up to 3 times, including command
// runs: an abort or timeout stops waiting while the request runs to completion at HOPX.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  APIError, AuthenticationError, FileNotFoundError, HopxError, HTTPClient, NetworkError, RateLimitError,
  ResourceLimitError, Sandbox, SandboxExpiredError, ServerError, TimeoutError, TokenExpiredError,
  type CommandOptions, type CommandResponse, type SandboxCreateOptions,
} from "@hopx-ai/sdk";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

/** The parts of a connected sandbox this provider uses; the SDK's `Sandbox` satisfies it. */
export interface HopxSandbox {
  readonly sandboxId: string;
  commands: { run(command: string, options?: CommandOptions): Promise<CommandResponse> };
  files: { readBytes(path: string): Promise<Buffer>; writeBytes(path: string, content: Buffer): Promise<void> };
  getPreviewUrl(port?: number): Promise<string>;
}

/** The SDK entry points this provider uses; tests pass a fake. */
export interface HopxSdk {
  /** Control-plane requests (`https://api.hopx.dev`), through the SDK's `HTTPClient`. */
  api: { get<T>(url: string): Promise<T>; post<T>(url: string, data?: unknown): Promise<T>; put<T>(url: string, data?: unknown): Promise<T>; delete<T>(url: string): Promise<T> };
  create(options: SandboxCreateOptions): Promise<HopxSandbox>;
  /** Resumes a paused sandbox. */
  connect(id: string): Promise<HopxSandbox>;
}

export interface HopxOptions {
  /** Default: the `HOPX_API_KEY` environment variable. */
  apiKey?: string;
  /** Template for new sandboxes when `create` names no image. Default `code-interpreter` (Python included). */
  template?: string;
  region?: string;
  /** Seconds until HOPX deletes a new sandbox. Default 3600; extend with `setTtl`. */
  ttlSeconds?: number;
  /** Default `https://api.hopx.dev`. */
  baseURL?: string;
  /** Secret that signs labels. Default: derived from the API key. */
  labelSecret?: string;
  name?: string;
  /** Override for tests. */
  sdk?: HopxSdk;
}

/** A sandbox as the control plane returns it (`GET /v1/sandboxes[/{id}]`). */
interface Raw { id?: string; sandbox_id?: string; status?: string; created_at?: string; expires_at?: string | null }

const STATES: Record<string, SandboxState> = { creating: "starting", running: "running", paused: "stopped", stopped: "gone", deleted: "gone" };
const IDEMPOTENCY = "open-sb.idempotency-key";
const LABELS_PATH = "/var/lib/open-sb/labels.json";
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const date = (value: string | null | undefined) => value ? new Date(value) : undefined;
const sandboxPath = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`;

export function hopx(options: HopxOptions = {}) {
  const name = options.name ?? "hopx";
  const apiKey = options.apiKey ?? process.env.HOPX_API_KEY;
  if (!apiKey && !options.sdk) throw new Error("hopx: pass apiKey or set HOPX_API_KEY");
  const { baseURL } = options;
  const sdk: HopxSdk = options.sdk ?? {
    api: new HTTPClient({ baseURL: baseURL ?? "https://api.hopx.dev", apiKey, timeout: 60_000, maxRetries: 3 }),
    create: createOptions => Sandbox.create({ ...createOptions, apiKey, baseURL }),
    connect: id => Sandbox.connect(id, apiKey, baseURL),
  };
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const labelKey = createHash("sha256").update(`open-sb/hopx labels\n${options.labelSecret ?? apiKey ?? ""}`).digest();
  /** Connected sandboxes, so agent calls skip the connect and token round trips. */
  const handles = new Map<string, HopxSandbox>();
  /** Verified labels by sandbox ID, including the idempotency label. */
  const known = new Map<string, Labels>();

  /** Maps SDK failures onto SandboxError; SDK messages carry provider bodies, so none reach ours. */
  function fail(error: unknown): unknown {
    if (error instanceof SandboxError) return error;
    if (error instanceof SandboxExpiredError) return new SandboxError("not_found", name, { status: error.statusCode, code: "expired" });
    if (error instanceof AuthenticationError || error instanceof TokenExpiredError) return new SandboxError("rejected", name, { status: 401, code: "unauthorized" });
    if (error instanceof RateLimitError || error instanceof ResourceLimitError) return new SandboxError("unavailable", name, { status: 429, code: "rate_limited" });
    if (error instanceof ServerError) return new SandboxError("unavailable", name, { status: error.statusCode, code: error.code });
    if (error instanceof FileNotFoundError) return new SandboxError("not_found", name, { status: 404, code: "file_not_found" });
    if (error instanceof TimeoutError || (error instanceof HopxError && error.code === "EXECUTION_TIMEOUT"))
      return new SandboxError("timeout", name, { status: error.statusCode, code: "execution_timeout" });
    if (error instanceof NetworkError) return httpError(name, null, "network");
    // The HTTP client turns a request without a response (refused, reset, timed out) into an APIError without a status.
    if (error instanceof APIError) return error.statusCode ? httpError(name, error.statusCode, error.code) : httpError(name, null, "network");
    if (error instanceof HopxError) return new SandboxError("rejected", name, { status: error.statusCode, code: error.code ?? "sdk_error" });
    return error;
  }

  /** Runs `work`, giving up on abort or after `timeoutMs`: the SDK takes no AbortSignal. */
  async function call<T>(work: () => Promise<T>, signal?: AbortSignal, timeoutMs = 180_000): Promise<T> {
    signal?.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    let onAbort = () => {};
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SandboxError("timeout", name, { code: "request_timeout" })), timeoutMs);
      onAbort = () => reject(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work().catch(error => { throw fail(error); }), stop]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Runs `work` on a connected sandbox (connecting resumes a paused one). A failed call drops the connection. */
  async function withSandbox<T>(id: string, signal: AbortSignal | undefined, work: (sandbox: HopxSandbox) => Promise<T>, timeoutMs?: number): Promise<T> {
    let sandbox = handles.get(id);
    if (!sandbox) {
      sandbox = await call(() => sdk.connect(id).catch(error => {
        // Connect refuses `stopped` and unexpected states with a plain Error.
        throw error instanceof HopxError ? error : new SandboxError("not_found", name, { code: "not_running" });
      }), signal);
      handles.set(id, sandbox);
    }
    const connected = sandbox;
    try {
      return await call(() => work(connected), signal, timeoutMs);
    } catch (error) {
      handles.delete(id);
      throw error;
    }
  }

  const sign = (id: string, labels: Labels) => createHmac("sha256", labelKey).update(`${id}\n${JSON.stringify(labels)}`).digest("hex");

  /** Labels from the VM's file, or undefined when it is missing, malformed or not signed by us. */
  function verify(id: string, bytes: Uint8Array): Labels | undefined {
    try {
      const { labels, signature } = JSON.parse(Buffer.from(bytes).toString()) as { labels?: unknown; signature?: unknown };
      if (!labels || typeof labels !== "object" || Array.isArray(labels) || typeof signature !== "string") return undefined;
      if (Object.values(labels).some(value => typeof value !== "string")) return undefined;
      const expected = Buffer.from(sign(id, labels as Labels));
      const actual = Buffer.from(signature);
      return expected.length === actual.length && timingSafeEqual(expected, actual) ? labels as Labels : undefined;
    } catch {
      return undefined;
    }
  }

  /** Known labels, or the VM's file when it is running; undefined when they cannot be read. */
  async function labelsOf(raw: Raw, signal?: AbortSignal): Promise<Labels | undefined> {
    const id = raw.id ?? raw.sandbox_id ?? "";
    const cached = known.get(id);
    if (cached || raw.status !== "running") return cached;
    try {
      const labels = verify(id, await withSandbox(id, signal, sandbox => sandbox.files.readBytes(LABELS_PATH)));
      if (labels) known.set(id, labels);
      return labels;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  const info = (raw: Raw, all: Labels | undefined): SandboxInfo => {
    const { [IDEMPOTENCY]: _key, ...labels } = all ?? {};
    const state = STATES[raw.status ?? ""] ?? "starting";
    return { id: raw.id ?? raw.sandbox_id ?? "", state, labels, createdAt: date(raw.created_at),
      expiresAt: state === "gone" ? undefined : date(raw.expires_at) };
  };

  /** Fresh control-plane state; `null` when HOPX no longer knows the sandbox. */
  async function fetchRaw(id: string, signal?: AbortSignal): Promise<Raw | null> {
    try {
      return await call(() => sdk.api.get<Raw>(sandboxPath(id)), signal);
    } catch (error) {
      if (error instanceof SandboxError && error.kind === "not_found") { handles.delete(id); known.delete(id); return null; }
      throw error;
    }
  }

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const { signal } = filter;
    const raws: Raw[] = [];
    for (let cursor: string | undefined, more = true; more;) {
      const page = await call(() => sdk.api.get<{ data?: Raw[]; has_more?: boolean; next_cursor?: string | null }>(
        `/v1/sandboxes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), signal);
      raws.push(...(page.data ?? []).filter(raw => raw?.id ?? raw?.sandbox_id));
      more = page.has_more === true;
      cursor = page.next_cursor ?? undefined;
      // A partial list would hide sandboxes, so refuse it.
      if (more && !cursor) throw new SandboxError("unavailable", name, { code: "list_incomplete" });
    }
    const wanted = Object.entries(filter.labels ?? {});
    const found: SandboxInfo[] = [];
    // Label files are read through each VM's agent, a few at a time.
    for (let index = 0; index < raws.length; index += 8) {
      const batch = raws.slice(index, index + 8);
      const labels = await Promise.all(batch.map(raw => labelsOf(raw, signal)));
      batch.forEach((raw, at) => {
        if (wanted.every(([key, value]) => labels[at]?.[key] === value)) found.push(info(raw, labels[at]));
      });
    }
    return found;
  }

  async function run(id: string, command: string, execOptions: ExecOptions = {}) {
    for (const key of Object.keys(execOptions.env ?? {}))
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const seconds = Math.max(1, Math.ceil((execOptions.timeoutMs ?? 300_000) / 1000));
    // The agent runs `bash -c command` with the environment as data, so values need no quoting.
    const result = await withSandbox(id, execOptions.signal, sandbox => sandbox.commands.run(command,
      { timeout: seconds, ...(execOptions.cwd ? { workingDir: execOptions.cwd } : {}), ...(execOptions.env ? { env: execOptions.env } : {}) }),
    seconds * 1000 + 60_000);
    if (typeof result?.exit_code !== "number") throw new SandboxError("unavailable", name, { code: "invalid_response" });
    return { exitCode: result.exit_code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "ttl", "ports", "background"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const labels: Labels = { ...createOptions.labels };
      if (createOptions.idempotencyKey) {
        labels[IDEMPOTENCY] = createHash("sha256").update(createOptions.idempotencyKey).digest("hex").slice(0, 32);
        const existing = (await list({ labels: { [IDEMPOTENCY]: labels[IDEMPOTENCY] }, signal })).find(sandbox => sandbox.state !== "gone");
        if (existing) return existing;
      }
      const sandbox = await call(() => sdk.create({ template: createOptions.image ?? options.template ?? "code-interpreter",
        timeoutSeconds: ttlSeconds, ...(options.region ? { region: options.region } : {}) }), signal, 360_000);
      const id = sandbox.sandboxId;
      try {
        let raw = await fetchRaw(id, signal);
        for (const until = Date.now() + 300_000; raw?.status === "creating" && Date.now() < until;) {
          await new Promise(done => setTimeout(done, 1_000));
          raw = await fetchRaw(id, signal);
        }
        if (raw?.status !== "running") throw new SandboxError("unavailable", name, { code: "create_failed" });
        // Labels go in before anyone can list the sandbox by them; a sandbox without them is deleted below.
        const file = Buffer.from(JSON.stringify({ labels, signature: sign(id, labels) }));
        handles.set(id, sandbox);
        await withSandbox(id, signal, async connected => {
          const made = await connected.commands.run(`mkdir -p ${quote(LABELS_PATH.replace(/\/[^/]*$/, ""))}`, { timeout: 30 });
          if (made.exit_code !== 0) throw new SandboxError("rejected", name, { code: "labels_not_writable" });
          await connected.files.writeBytes(LABELS_PATH, file);
        });
        known.set(id, labels);
        return info(raw, labels);
      } catch (error) {
        handles.delete(id);
        await call(() => sdk.api.delete(sandboxPath(id))).catch(() => undefined);
        throw error;
      }
    },

    async get(id, callOptions = {}) {
      const raw = await fetchRaw(id, callOptions.signal);
      return raw && info(raw, await labelsOf(raw, callOptions.signal));
    },

    list,

    async destroy(id, callOptions = {}) {
      handles.delete(id);
      try {
        await call(() => sdk.api.delete(sandboxPath(id)), callOptions.signal);
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
      known.delete(id);
    },

    exec: run,

    async readFile(id, path, callOptions = {}) {
      return new Uint8Array(await withSandbox(id, callOptions.signal, sandbox => sandbox.files.readBytes(path), 300_000));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const parent = path.replace(/\/[^/]*$/, "") || "/";
      // Not documented to create missing parent directories, so make them first.
      const made = await run(id, `mkdir -p -- ${quote(parent)}`, { signal: callOptions.signal, timeoutMs: 30_000 });
      if (made.exitCode !== 0) throw new SandboxError("rejected", name, { code: "write_failed" });
      await withSandbox(id, callOptions.signal, sandbox => sandbox.files.writeBytes(path, typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)), 300_000);
    },

    /** Keeps memory and files; the agent does not answer until `resume`. */
    async pause(id, callOptions = {}) {
      handles.delete(id);
      await call(() => sdk.api.post(`${sandboxPath(id)}/pause`), callOptions.signal, 300_000);
    },

    async resume(id, callOptions = {}) {
      await call(() => sdk.api.post(`${sandboxPath(id)}/resume`), callOptions.signal, 300_000);
    },

    /** HOPX deletes the sandbox `seconds` from now. */
    async setTtl(id, seconds, callOptions = {}) {
      if (!(seconds > 0)) throw new SandboxError("rejected", name, { code: "invalid_ttl" });
      await call(() => sdk.api.put(`${sandboxPath(id)}/timeout`, { timeout_seconds: Math.ceil(seconds) }), callOptions.signal);
    },

    /** The public preview host HOPX gives every port. */
    async portUrl(id, port, callOptions = {}) {
      return { url: await withSandbox(id, callOptions.signal, sandbox => sandbox.getPreviewUrl(port)) };
    },

    /** The agent kills commands at their timeout, so the process detaches into its own session first. */
    async startBackground(id, command, execOptions = {}) {
      const started = await run(id, `nohup setsid bash -c ${quote(command)} </dev/null >/dev/null 2>&1 &`,
        { ...execOptions, timeoutMs: 30_000 });
      if (started.exitCode !== 0) throw new SandboxError("rejected", name, { code: "background_start_failed" });
    },
  });
}
