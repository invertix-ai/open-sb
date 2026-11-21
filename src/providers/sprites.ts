// Fly.io Sprites (sprites.dev): persistent Firecracker VMs addressed by a unique name. The disk persists for
// the sprite's whole life. After about 30 s idle a sprite suspends itself ("warm", memory frozen) and later
// stops ("cold"); any request wakes it in under 2 s. Since waking is transparent, open-sb reports
// running, warm and cold all as `running`. Labels are native (a list of strings) and stored as `key=value`;
// listing has no label filter, so `list` filters here. An idempotency key becomes a deterministic name.
// Uses the official `@fly/sprites` SDK (a peer dependency, Node 24 or later). Left out:
// - pause and persistentDisk: the API has no call to suspend or stop a sprite; it only does so by itself.
// - snapshot: checkpoints (`v0`, `v1`...) belong to one sprite and restore in place; no new sprite can start
//   from one, and their IDs are assigned, not caller-chosen.
// - ttl: sprites never expire on their own; only `destroy` deletes them.
// - ports: a sprite has one URL, routed to its single HTTP service (port 8080 by default), not one per port.
// - ssh and desktop: no SSH endpoint and no desktop through the API.
// The SDK's REST calls take no AbortSignal, so an abort or timeout stops the wait, not the request.
import { createHash, randomBytes } from "node:crypto";
import { APIError, ExecError, FilesystemError, SpritesClient, type Sprite } from "@fly/sprites";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

export interface SpritesOptions {
  /** Sprites access token (sprites.dev/account or `SpritesClient.createToken`). */
  token: string;
  /** Default `https://api.sprites.dev`. */
  baseURL?: string;
  /** Prefix for generated sprite names. Default `open-sb-`. */
  prefix?: string;
  /** Size of new sprites. Default: the API's. */
  config?: { ramMB?: number; cpus?: number; region?: string; storageGB?: number };
  name?: string;
  /** Override for tests: replaces the SDK client built from `token`. */
  client?: SpritesSdk;
}

/** The parts of the SDK used here. */
export interface SpritesSdk {
  createSprite(name: string, options?: { config?: SpritesOptions["config"]; labels?: string[]; runtime?: "default" | "dev" }): Promise<SpriteRecord>;
  getSprite(name: string): Promise<SpriteRecord>;
  listSprites(options?: { maxResults?: number; continuationToken?: string }): Promise<{ sprites: SpriteRecord[]; hasMore: boolean; nextContinuationToken?: string }>;
  deleteSprite(name: string): Promise<void>;
  sprite(name: string): Pick<Sprite, "execFile" | "filesystem" | "createSession">;
}

interface SpriteRecord { name: string; status?: string; labels?: string[]; createdAt?: Date }

const STATES: Record<string, SandboxState> = { running: "running", warm: "running", cold: "running" };
/** `create({ image })` picks one of the two runtimes; Sprites has no other images. */
const RUNTIMES = new Set(["default", "dev"]);
const SLOW = 150_000;

/** A label `key=value` as stored on the sprite; keys may not contain `=`. */
const encode = (provider: string, labels: Labels) => Object.entries(labels).map(([key, value]) => {
  if (!key || key.includes("="))
    throw new SandboxError("rejected", provider, { code: "invalid_label", message: `${provider}: label keys must be non-empty and contain no '='` });
  return `${key}=${value}`;
});
const decode = (labels: string[] = []): Labels => Object.fromEntries(labels.map(label => {
  const at = label.indexOf("=");
  return at < 0 ? [label, ""] : [label.slice(0, at), label.slice(at + 1)];
}));

export function sprites(options: SpritesOptions) {
  const name = options.name ?? "sprites";
  const prefix = options.prefix ?? "open-sb-";
  const client: SpritesSdk = options.client ?? new SpritesClient(options.token, { baseURL: options.baseURL });

  /** Maps SDK failures onto SandboxError. SDK messages carry response bodies and URLs, so none reach ours. */
  function fail(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted) return signal.reason ?? error;
    if (error instanceof SandboxError) return error;
    if (error instanceof APIError)
      return error.statusCode ? httpError(name, error.statusCode, error.errorCode, error.getRetryAfterSeconds()) : new SandboxError("unavailable", name, { code: error.errorCode ?? "api_error" });
    if (error instanceof FilesystemError) {
      if (error.code === "ENOENT") return new SandboxError("not_found", name, { code: "file_not_found" });
      // The SDK drops the HTTP status of file errors; UNKNOWN and EIO are the server failing.
      if (error.code === "UNKNOWN" || error.code === "EIO") return new SandboxError("unavailable", name, { code: "file_error" });
      return new SandboxError("rejected", name, { code: error.code });
    }
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      return new SandboxError("timeout", name, { code: "request_timeout" });
    // A failed fetch is a TypeError; the client wraps it as "Network error: ...".
    if (error instanceof TypeError) return httpError(name, null, "network");
    if (error instanceof Error) {
      // Some SDK calls throw plain errors worded "... (status 503): <body>"; only the status is read.
      const status = /\(status (\d{3})\)/.exec(error.message)?.[1];
      if (status) return httpError(name, Number(status));
      if (/^(Network error|WebSocket)/.test(error.message)) return httpError(name, null, "network");
    }
    return error;
  }

  /** Runs an SDK call, honouring abort and a deadline (the SDK's REST calls take no signal). */
  async function call<T>(work: () => Promise<T>, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
    signal?.throwIfAborted();
    let stop = () => {};
    const stopped = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new SandboxError("timeout", name, { code: "request_timeout" })), timeoutMs);
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    });
    try {
      return await Promise.race([Promise.resolve().then(work), stopped]);
    } catch (error) {
      throw fail(error, signal);
    } finally {
      stop();
    }
  }

  const info = (sprite: SpriteRecord): SandboxInfo => ({
    id: sprite.name,
    state: STATES[sprite.status ?? ""] ?? "starting",
    labels: decode(sprite.labels),
    createdAt: sprite.createdAt,
  });

  const notFound = (error: unknown) => error instanceof SandboxError && error.kind === "not_found";

  async function get(id: string, callOptions: CallOptions = {}) {
    try {
      return info(await call(() => client.getSprite(id), callOptions.signal));
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  /** Exec sockets report no HTTP status; a failed one on a deleted sprite is `not_found`, not an outage. */
  async function socketFailure(id: string, error: unknown, signal?: AbortSignal): Promise<unknown> {
    const mapped = fail(error, signal);
    if (!(mapped instanceof SandboxError) || mapped.kind !== "unavailable" || signal?.aborted) return mapped;
    return (await get(id).catch(() => undefined)) === null ? new SandboxError("not_found", name, { status: 404 }) : mapped;
  }

  return defineProvider({
    name,
    capabilities: ["background"] as const,

    async create(createOptions = {}) {
      const { signal, image } = createOptions;
      if (image !== undefined && !RUNTIMES.has(image))
        throw new SandboxError("rejected", name, { code: "image_unsupported", message: `${name}: image must be "default" or "dev"` });
      const labels = { ...createOptions.labels };
      const encoded = encode(name, labels);
      // A retried key names the same sprite; the hash keeps names to lowercase letters, digits and hyphens.
      const key = createOptions.idempotencyKey;
      const id = prefix + (key ? createHash("sha256").update(key).digest("hex").slice(0, 32) : randomBytes(12).toString("hex"));
      if (key) {
        const existing = await get(id, { signal });
        if (existing) return existing;
      }
      try {
        return info(await call(() => client.createSprite(id, { config: options.config, labels: encoded,
          runtime: image as "default" | "dev" | undefined }), signal, SLOW));
      } catch (error) {
        // Two retries racing with one key: the loser finds the winner's sprite.
        if (key && error instanceof SandboxError && error.kind === "rejected") {
          const existing = await get(id, { signal });
          if (existing) return existing;
        }
        throw error;
      }
    },

    get,

    async list(filter = {}) {
      const wanted = Object.entries(filter.labels ?? {});
      const found: SandboxInfo[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await call(() => client.listSprites({ maxResults: 100, continuationToken }), filter.signal);
        found.push(...page.sprites.map(info));
        continuationToken = page.hasMore ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      return found.filter(sandbox => wanted.every(([key, value]) => sandbox.labels[key] === value));
    },

    async destroy(id, callOptions = {}) {
      try {
        await call(() => client.deleteSprite(id), callOptions.signal);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    async exec(id, command, execOptions: ExecOptions = {}) {
      const { signal } = execOptions;
      signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(execOptions.timeoutMs ?? 300_000);
      try {
        // `sh -c` keeps the command whole; the SDK's `exec` would split it on spaces. Env and cwd go as API fields.
        const result = await client.sprite(id).execFile("sh", ["-c", command], { env: execOptions.env, cwd: execOptions.cwd,
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
        return { exitCode: result.exitCode, stdout: String(result.stdout), stderr: String(result.stderr) };
      } catch (error) {
        // The SDK throws on a nonzero exit; open-sb reports it.
        if (error instanceof ExecError) return { exitCode: error.exitCode, stdout: String(error.stdout), stderr: String(error.stderr) };
        if (signal?.aborted) throw signal.reason ?? error;
        if (deadline.aborted) throw new SandboxError("timeout", name, { code: "exec_timeout" });
        throw await socketFailure(id, error, signal);
      }
    },

    async readFile(id, path, callOptions = {}) {
      const data = await call(() => client.sprite(id).filesystem().readFile(path, null), callOptions.signal, SLOW);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },

    async writeFile(id, path, data, callOptions = {}) {
      // The SDK asks the server to create missing parent directories.
      const body = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      await call(() => client.sprite(id).filesystem().writeFile(path, body), callOptions.signal, SLOW);
    },

    /**
     * A detachable session (tmux on the sprite) that outlives the call. While the sprite is idle and
     * suspended, the process is frozen with it and continues when the sprite wakes.
     */
    async startBackground(id, command, execOptions = {}) {
      const { signal } = execOptions;
      signal?.throwIfAborted();
      const session = client.sprite(id).createSession("sh", ["-c", command], { env: execOptions.env, cwd: execOptions.cwd });
      try {
        await call(() => new Promise<void>((started, failed) => {
          session.once("spawn", () => started());
          session.once("error", failed);
        }), signal);
      } catch (error) {
        session.close();
        throw error instanceof SandboxError && error.kind === "unavailable" ? await socketFailure(id, error, signal) : error;
      }
      // Closing the socket detaches; the session keeps running.
      session.close();
    },
  });
}
