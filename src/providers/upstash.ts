// Upstash Box (upstash.com/docs/box): containers built to host coding agents, driven here through their shell
// and file APIs. A box auto-pauses when idle (1 h free plan, 6 h paid) and keeps its filesystem; new work or
// `resume` wakes it. Ports get public `https://<id>-<port>.preview.box.upstash.com` URLs, protected by a
// bearer token unless `publicPorts` is set. `image` picks a runtime (`node`, `python`, `golang`, `ruby`,
// `rust`, or their `-alpine` variants); there are no custom images.
//
// Labels are emulated. Native labels are bare strings (at most 5, 20 characters, [A-Za-z0-9._:-]), so each
// key/value pair is stored as `osb:` plus 16 characters of its SHA-256, which `list` filters on exactly; the
// values themselves live in the box's init command as a no-op line (`: open-sb-labels <base64url JSON>`),
// which the API reads without waking a paused box. Hence at most 5 labels, and an init command of your own
// cannot be combined with this provider. Idempotency uses the box name (`open-sb-<hash of the key>`).
//
// Left out: `snapshot` (snapshots are listed only per box and outlive their box, so there is no exact
// account-wide `listSnapshots` or delete by name); `ttl` (only ephemeral boxes expire, fixed at creation and
// without pause); `ssh` (the gateway takes the API key or keys added in the Console, not per-box keys, and
// has no pinned host key); `desktop` (the browser live view is per tab and view-only). The SDK takes no
// AbortSignal: an aborted call stops waiting but the request may still complete. Uses the official
// `@upstash/box` SDK (a peer dependency).
import { createHash } from "node:crypto";
import { Box, BoxError, type Runtime } from "@upstash/box";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

export interface UpstashOptions {
  /** Default: the SDK reads `UPSTASH_BOX_API_KEY`. */
  apiKey?: string;
  /** API address. Default: the SDK's (`UPSTASH_BOX_BASE_URL`, else `https://us-east-1.box.upstash.com`). */
  baseUrl?: string;
  /** Runtime when `create` names no image. Default: the API's. */
  runtime?: Runtime;
  size?: "small" | "medium" | "large";
  /** Port URLs without a bearer token: anyone with the URL reaches the port. Default false. */
  publicPorts?: boolean;
  /** Longest a single API request may take, commands included. Default 10 minutes (the SDK's). */
  requestTimeoutMs?: number;
  name?: string;
  /** Override for tests: the SDK's static `Box.create`, `get`, `list` and `delete`. */
  sdk?: UpstashSdk;
}

export interface UpstashSdk {
  create: typeof Box.create;
  get: typeof Box.get;
  list: typeof Box.list;
  delete: typeof Box.delete;
}

const RUNTIMES = new Set<string>(["node", "python", "golang", "ruby", "rust", "node-alpine", "python-alpine", "golang-alpine", "ruby-alpine", "rust-alpine"]);
const STATES: Record<string, SandboxState> = { creating: "starting", idle: "running", running: "running", paused: "stopped", error: "gone", deleted: "gone" };
const LABEL_LINE = /^: open-sb-labels ([A-Za-z0-9_-]*)$/m;
const MAX_LABELS = 5;

/** One native label per key/value pair: 20 characters, the API's maximum. */
const labelTag = (key: string, value: string) => "osb:" + createHash("sha256").update(`${key}\0${value}`).digest("base64url").slice(0, 16);
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** API timestamps are Unix seconds; tolerate milliseconds. */
const date = (value: number | undefined) => value === undefined ? undefined : new Date(value < 1e12 ? value * 1000 : value);

function decodeLabels(initCommand: string): Labels {
  const encoded = LABEL_LINE.exec(initCommand)?.[1];
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString()) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function upstash(options: UpstashOptions = {}) {
  const name = options.name ?? "upstash";
  const sdk: UpstashSdk = options.sdk ?? Box;
  const requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
  const connection = { ...(options.apiKey ? { apiKey: options.apiKey } : {}), ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) };
  const handles = new Map<string, Box>();

  /** Maps SDK failures onto SandboxError. SDK messages carry provider bodies, so none reach ours. */
  function fail(error: unknown): unknown {
    if (error instanceof SandboxError) return error;
    if (error instanceof BoxError) {
      if (error.statusCode) return httpError(name, error.statusCode);
      // Status-less BoxErrors are the SDK's own: its timeouts, missing credentials, keep-alive, or a wrapped
      // network failure (its request helper rewraps those without a status).
      if (/timed? ?out/i.test(error.message)) return new SandboxError("timeout", name, { code: "request_timeout" });
      if (/^apiKey is required/.test(error.message)) return new SandboxError("rejected", name, { code: "missing_credentials" });
      if (/^Keep-alive boxes/.test(error.message)) return new SandboxError("rejected", name, { code: "keep_alive" });
      if (/^Box creation failed/.test(error.message)) return new SandboxError("unavailable", name, { code: "create_failed" });
      return httpError(name, null, "network");
    }
    // The static methods call fetch directly: a failed fetch is a TypeError, a garbled body a SyntaxError.
    if (error instanceof TypeError) return httpError(name, null, "network");
    if (error instanceof SyntaxError) return new SandboxError("unavailable", name, { code: "invalid_response" });
    return error;
  }

  /** Runs `work`, giving up after `timeoutMs` or when `signal` aborts (the request itself cannot be cancelled). */
  async function call<T>(work: () => Promise<T>, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    let stop: (error: unknown) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => { stop = reject; });
    const onAbort = () => stop(signal!.reason);
    const timer = setTimeout(() => stop(new SandboxError("timeout", name, { code: "request_timeout" })), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([work(), stopped]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw fail(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** A fresh handle (current status); `null` when the box does not exist. */
  async function fetchBox(id: string, signal?: AbortSignal): Promise<Box | null> {
    try {
      const box = await call(() => sdk.get(id, { ...connection, timeout: requestTimeoutMs }), signal);
      handles.set(box.id, box);
      return box;
    } catch (error) {
      if (error instanceof SandboxError && error.kind === "not_found") { handles.delete(id); return null; }
      throw error;
    }
  }

  /** A handle for commands and files; a paused box wakes on the next request. */
  async function handle(id: string, signal?: AbortSignal): Promise<Box> {
    const box = handles.get(id) ?? await fetchBox(id, signal);
    if (!box) throw new SandboxError("not_found", name);
    return box;
  }

  async function labelsOf(box: Box, signal?: AbortSignal): Promise<Labels> {
    try {
      return decodeLabels(await call(() => box.getInitCommand(), signal));
    } catch (error) {
      // A deleted box may no longer answer for its init command.
      if (error instanceof SandboxError && error.kind === "not_found") return {};
      throw error;
    }
  }

  async function info(box: Box, status: string, createdAt: number | undefined, signal?: AbortSignal): Promise<SandboxInfo> {
    return { id: box.id, state: STATES[status] ?? "starting", labels: await labelsOf(box, signal), createdAt: date(createdAt) };
  }

  /** A handle carries no status, so it is asked for. */
  async function describe(box: Box, signal?: AbortSignal): Promise<SandboxInfo> {
    return info(box, (await call(() => box.getStatus(), signal)).status, undefined, signal);
  }

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    const tags = wanted.map(([key, value]) => labelTag(key, value));
    // The API filters on one label; the remaining tags are checked here, then the decoded values.
    const boxes = await call(() => sdk.list({ ...connection, ...(tags[0] ? { label: tags[0] } : {}) }), filter.signal, 120_000);
    const candidates = boxes.filter(data => tags.every(tag => data.labels?.includes(tag)));
    const found = await Promise.all(candidates.map(async data => {
      const box = handles.get(data.id) ?? await fetchBox(data.id, filter.signal);
      return box ? info(box, data.status, data.created_at, filter.signal) : null;
    }));
    return found.filter((sandbox): sandbox is SandboxInfo => sandbox !== null &&
      wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  /** One `sh -c` script: exports, directory, then the command (under `timeout` when one is set). */
  function script(command: string, execOptions: ExecOptions): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(execOptions.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      lines.push(`export ${key}=${quote(value)}`);
    }
    if (execOptions.cwd) lines.push(`cd ${quote(execOptions.cwd)} || exit 1`);
    lines.push(execOptions.timeoutMs
      ? `exec timeout -k 5 ${Math.max(1, Math.ceil(execOptions.timeoutMs / 1000))} sh -c ${quote(command)}`
      : command);
    return lines.join("\n");
  }

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "ports", "background"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const labels = { ...createOptions.labels };
      if (Object.keys(labels).length > MAX_LABELS) throw new SandboxError("rejected", name, { code: "too_many_labels" });
      const image = createOptions.image ?? options.runtime;
      if (image !== undefined && !RUNTIMES.has(image)) throw new SandboxError("rejected", name, { code: "unknown_runtime" });
      // Names are unique per account: an idempotency key becomes the name, so a retried create finds the first.
      const boxName = createOptions.idempotencyKey
        ? `open-sb-${createHash("sha256").update(createOptions.idempotencyKey).digest("hex").slice(0, 32)}` : undefined;
      const existing = async () => {
        const box = boxName ? await fetchBox(boxName, signal) : null;
        if (!box) return null;
        const current = await describe(box, signal);
        return current.state === "gone" ? null : current;
      };
      const found = await existing();
      if (found) return found;
      const config = {
        ...connection, timeout: requestTimeoutMs, labels: Object.entries(labels).map(([key, value]) => labelTag(key, value)),
        ...(Object.keys(labels).length ? { initCommand: `: open-sb-labels ${Buffer.from(JSON.stringify(labels)).toString("base64url")}` } : {}),
        ...(boxName ? { name: boxName } : {}), ...(image ? { runtime: image as Runtime } : {}), ...(options.size ? { size: options.size } : {}),
      };
      try {
        // The SDK polls up to 5 minutes for the box to leave `creating`.
        const box = await call(() => sdk.create(config), signal, 330_000);
        handles.set(box.id, box);
        return { id: box.id, state: "running", labels, createdAt: new Date() };
      } catch (error) {
        // Two concurrent retries: the loser of the name race returns the winner's box.
        if (boxName && error instanceof SandboxError && error.status === 409) {
          const winner = await existing();
          if (winner) return winner;
        }
        throw error;
      }
    },

    async get(id, callOptions = {}) {
      const box = await fetchBox(id, callOptions.signal);
      try {
        return box && await describe(box, callOptions.signal);
      } catch (error) {
        // Deleted between the two requests.
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      handles.delete(id);
      try {
        await call(() => sdk.delete({ ...connection, boxIds: id }), callOptions.signal);
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    async exec(id, command, execOptions = {}) {
      const box = await handle(id, execOptions.signal);
      const run = await call(() => box.exec.command(script(command, execOptions)), execOptions.signal, requestTimeoutMs + 30_000);
      // `timeout` exits 124 when it stops the command.
      if (execOptions.timeoutMs && run.exitCode === 124) throw new SandboxError("timeout", name, { code: "command_timeout" });
      return { exitCode: run.exitCode ?? -1, stdout: run.stdout, stderr: run.stderr };
    },

    async readFile(id, path, callOptions = {}) {
      const box = await handle(id, callOptions.signal);
      const content = await call(() => box.files.read(path, { encoding: "base64" }), callOptions.signal, requestTimeoutMs);
      return new Uint8Array(Buffer.from(content, "base64"));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const box = await handle(id, callOptions.signal);
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent) await call(() => box.files.mkdir(parent, { parents: true }), callOptions.signal);
      const content = (typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)).toString("base64");
      await call(() => box.files.write({ path, content, encoding: "base64" }), callOptions.signal, requestTimeoutMs);
    },

    /** Releases compute and keeps the filesystem. Keep-alive boxes cannot pause. */
    async pause(id, callOptions = {}) {
      const box = await fetchBox(id, callOptions.signal);
      if (!box) throw new SandboxError("not_found", name);
      if ((await call(() => box.getStatus(), callOptions.signal)).status === "paused") return;
      await call(() => box.pause(), callOptions.signal, 300_000);
    },

    async resume(id, callOptions = {}) {
      const box = await fetchBox(id, callOptions.signal);
      if (!box) throw new SandboxError("not_found", name);
      if ((await call(() => box.getStatus(), callOptions.signal)).status !== "paused") return;
      await call(() => box.resume(), callOptions.signal, 300_000);
    },

    /** A public HTTPS URL; a request to it wakes a paused box. Unless `publicPorts`, it needs the returned header. */
    async portUrl(id, port, callOptions = {}) {
      const box = await handle(id, callOptions.signal);
      const bearerToken = !options.publicPorts;
      const open = () => call(() => box.getPublicURL(port, { bearerToken }), callOptions.signal);
      let url;
      try {
        url = await open();
      } catch (error) {
        // The token is only returned when the URL is created: replace an existing URL to get a fresh one.
        if (!(error instanceof SandboxError && error.status === 409)) throw error;
        await call(() => box.deletePublicURL(port), callOptions.signal);
        url = await open();
      }
      if (bearerToken && !url.token) throw new SandboxError("unavailable", name, { code: "missing_token" });
      return { url: url.url, ...(url.token ? { headers: { Authorization: `Bearer ${url.token}` } } : {}) };
    },

    /** Detached from the request with `nohup`, output discarded; it runs until the box pauses or is deleted. */
    async startBackground(id, command, execOptions = {}) {
      const box = await handle(id, execOptions.signal);
      const detached = `nohup sh -c ${quote(script(command, execOptions))} >/dev/null 2>&1 </dev/null &`;
      const run = await call(() => box.exec.command(detached), execOptions.signal);
      if (run.exitCode !== 0) throw new SandboxError("rejected", name, { code: "background_failed" });
    },
  });
}
