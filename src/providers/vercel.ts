// Vercel Sandbox (vercel.com/docs/vercel-sandbox): Firecracker microVMs addressed by a unique name. Sandboxes
// are persistent: stopping one snapshots its filesystem and the next session restores it, so pause and resume
// keep the disk. A session lives at most `timeout` (plan limit: 45 min Hobby, 5 h Pro) and then stops on its
// own. Ports must be declared to get a public `https://<sub>.vercel.run` route; the URL carries no
// credential. Tags are capped at 5 and listing filters on one tag only, so the rest is filtered here.
// Snapshots are left out: Vercel assigns snapshot IDs (no caller-chosen names), and taking one stops the
// sandbox. Uses the official `@vercel/sandbox` (v4, a peer dependency).
import { createHash } from "node:crypto";
import { APIError, Sandbox, StreamError } from "@vercel/sandbox";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

export interface VercelOptions {
  /** Access token. With `teamId` and `projectId`; all three or none (then the SDK uses VERCEL_OIDC_TOKEN). */
  token?: string;
  teamId?: string;
  projectId?: string;
  /** Default image (a Vercel Container Registry reference). Default: `vercel/sandbox/universal`. */
  image?: string;
  /** Session lifetime given to new sandboxes. Default 15 minutes; extend with `setTtl`. */
  timeoutMs?: number;
  /** Ports exposed at creation (up to 15). `portUrl` also tries to add an undeclared port to a live sandbox. */
  ports?: number[];
  vcpus?: number;
  name?: string;
  /** Override for tests: an object with the SDK's static `Sandbox.create`, `get` and `list`. */
  sdk?: VercelSdk;
}

export interface VercelSdk {
  create: typeof Sandbox.create;
  get: typeof Sandbox.get;
  list: typeof Sandbox.list;
}

/** What `get` and `list` return, reduced to the fields used here. */
interface Summary { name: string; status: string; tags?: Labels; createdAt: number | Date; expiresAt?: number | Date }

const STATES: Record<string, SandboxState> = {
  pending: "starting", running: "running",
  stopping: "stopped", snapshotting: "stopped", stopped: "stopped", aborted: "stopped",
  failed: "gone",
};
const IDEMPOTENCY_TAG = "open-sb.idempotency-key";
const date = (value: number | Date | undefined) => value === undefined ? undefined : new Date(value);

export function vercel(options: VercelOptions = {}) {
  const name = options.name ?? "vercel";
  const sdk: VercelSdk = options.sdk ?? Sandbox;
  // The SDK takes all three credentials or none; partial ones are a configuration error.
  const credentials = options.token || options.teamId || options.projectId
    ? { token: options.token!, teamId: options.teamId!, projectId: options.projectId! } : {};
  const sandboxes = new Map<string, Sandbox>();

  /** Maps SDK failures onto SandboxError; provider bodies and messages never reach ours. */
  async function call<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await work(signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof SandboxError) throw error;
      if (error instanceof APIError) {
        const response = (error as APIError<unknown>).response;
        if (response.ok) throw new SandboxError("unavailable", name, { status: response.status, code: "invalid_response" });
        const code = (error.json as { error?: { code?: unknown } } | undefined)?.error?.code;
        const retry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        throw httpError(name, response.status, typeof code === "string" ? code : undefined, Number.isFinite(retry) ? retry : undefined);
      }
      if (timeout.aborted) throw new SandboxError("timeout", name, { code: "request_timeout" });
      if (error instanceof StreamError) throw new SandboxError("unavailable", name, { code: "stream_interrupted" });
      if (error instanceof TypeError) throw httpError(name, null, "network");
      if (error instanceof Error && /OidcContextError$/.test(error.name)) throw new SandboxError("rejected", name, { code: "missing_credentials" });
      throw error;
    }
  }

  const info = (sandbox: Summary): SandboxInfo => {
    const { [IDEMPOTENCY_TAG]: _key, ...labels } = sandbox.tags ?? {};
    return { id: sandbox.name, state: STATES[sandbox.status] ?? "starting", labels,
      createdAt: date(sandbox.createdAt), expiresAt: sandbox.status === "running" ? date(sandbox.expiresAt) : undefined };
  };

  /** A handle for commands and files; the SDK resumes a stopped session on its own. */
  async function handle(id: string, signal?: AbortSignal): Promise<Sandbox> {
    const cached = sandboxes.get(id);
    if (cached) return cached;
    const sandbox = await call(s => sdk.get({ ...credentials, name: id, signal: s }), signal);
    sandboxes.set(id, sandbox);
    return sandbox;
  }

  /** Fresh state (never cached); `null` when the sandbox does not exist. */
  async function fetch(id: string, signal?: AbortSignal): Promise<Sandbox | null> {
    try {
      return await call(s => sdk.get({ ...credentials, name: id, signal: s }), signal);
    } catch (error) {
      if (error instanceof SandboxError && error.kind === "not_found") { sandboxes.delete(id); return null; }
      throw error;
    }
  }

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    // The API filters on a single tag; the remaining labels are checked here.
    // (Cast: the SDK's type only accepts a literal single-key object.)
    const first = wanted[0] ? { [wanted[0][0]]: wanted[0][1] } as Record<"tag", string> : undefined;
    const all = await call(async s => (await sdk.list({ ...credentials, ...(first ? { tags: first } : {}), signal: s })).toArray(), filter.signal, 120_000);
    return all.map(info).filter(sandbox => wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  function command(command: string, execOptions: ExecOptions) {
    const env = execOptions.env ?? {};
    for (const key of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    return { cmd: "bash", args: ["-c", command], env, cwd: execOptions.cwd, timeoutMs: execOptions.timeoutMs ?? 600_000 };
  }

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "ttl", "ports", "background"] as const,

    async create(createOptions = {}) {
      const labels = { ...createOptions.labels };
      // Names are unique per project: an idempotency key becomes the name, so a retried create finds the first.
      let sandboxName: string | undefined;
      if (createOptions.idempotencyKey) {
        labels[IDEMPOTENCY_TAG] = createHash("sha256").update(createOptions.idempotencyKey).digest("hex").slice(0, 32);
        sandboxName = `open-sb-${labels[IDEMPOTENCY_TAG]}`;
        const existing = await fetch(sandboxName, createOptions.signal);
        if (existing && existing.status !== "failed") return info(existing);
      }
      if (Object.keys(labels).length > 5) throw new SandboxError("rejected", name, { code: "too_many_labels" });
      const image = createOptions.image ?? options.image;
      try {
        const created = await call(s => sdk.create({ ...credentials, name: sandboxName, persistent: true,
          timeout: options.timeoutMs ?? 900_000, ports: options.ports, tags: labels,
          ...(options.vcpus ? { resources: { vcpus: options.vcpus } } : {}), ...(image ? { image } : {}), signal: s }),
        createOptions.signal, 300_000);
        sandboxes.set(created.name, created);
        return info(created);
      } catch (error) {
        // Two concurrent retries: the loser of the name race returns the winner's sandbox.
        if (sandboxName && error instanceof SandboxError && error.status === 409) {
          const existing = await fetch(sandboxName, createOptions.signal);
          if (existing) return info(existing);
        }
        throw error;
      }
    },

    async get(id, callOptions = {}) {
      const sandbox = await fetch(id, callOptions.signal);
      return sandbox && info(sandbox);
    },

    list,

    async destroy(id, callOptions = {}) {
      const sandbox = await fetch(id, callOptions.signal);
      sandboxes.delete(id);
      if (!sandbox) return;
      try {
        await call(s => sandbox.delete({ deleteOrphanSnapshots: true, signal: s }), callOptions.signal);
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    async exec(id, commandLine, execOptions = {}) {
      const sandbox = await handle(id, execOptions.signal);
      const params = command(commandLine, execOptions);
      return call(async s => {
        const finished = await sandbox.runCommand({ ...params, signal: s });
        const [stdout, stderr] = await Promise.all([finished.stdout({ signal: s }), finished.stderr({ signal: s })]);
        return { exitCode: finished.exitCode, stdout, stderr };
      }, execOptions.signal, params.timeoutMs + 30_000);
    },

    async readFile(id, path, callOptions = {}) {
      const sandbox = await handle(id, callOptions.signal);
      const buffer = await call(s => sandbox.readFileToBuffer({ path }, { signal: s }), callOptions.signal, 300_000);
      if (!buffer) throw new SandboxError("not_found", name, { code: "file_not_found" });
      return new Uint8Array(buffer);
    },

    async writeFile(id, path, data, callOptions = {}) {
      const sandbox = await handle(id, callOptions.signal);
      await call(s => sandbox.writeFiles([{ path, content: data }], { signal: s }), callOptions.signal, 300_000);
    },

    /** Stops the session; the filesystem is snapshotted and restored on resume. */
    async pause(id, callOptions = {}) {
      const sandbox = await fetch(id, callOptions.signal);
      if (!sandbox) throw new SandboxError("not_found", name);
      if (STATES[sandbox.status] === "stopped") return;
      await call(s => sandbox.stop({ signal: s }), callOptions.signal, 300_000);
    },

    async resume(id, callOptions = {}) {
      const sandbox = await call(s => sdk.get({ ...credentials, name: id, resume: true, signal: s }), callOptions.signal, 300_000);
      sandboxes.set(id, sandbox);
    },

    /**
     * Sets the running session to stop `seconds` from now. Vercel can only extend a session, so a shorter
     * lifetime is refused; on a stopped sandbox it sets the lifetime of the next session.
     */
    async setTtl(id, seconds, callOptions = {}) {
      const sandbox = await fetch(id, callOptions.signal);
      if (!sandbox) throw new SandboxError("not_found", name);
      const expiresAt = sandbox.status === "running" ? sandbox.expiresAt : undefined;
      if (!expiresAt) return void await call(s => sandbox.update({ timeout: seconds * 1000 }, { signal: s }), callOptions.signal);
      const extendBy = Date.now() + seconds * 1000 - expiresAt.getTime();
      if (extendBy > 0) await call(s => sandbox.extendTimeout(extendBy, { signal: s }), callOptions.signal);
      else if (extendBy < -60_000) throw new SandboxError("rejected", name, { code: "ttl_cannot_shorten" });
    },

    /** Public URL of a port. An undeclared port is added to the sandbox first, when Vercel allows it. */
    async portUrl(id, port, callOptions = {}) {
      let sandbox = await fetch(id, callOptions.signal);
      if (!sandbox) throw new SandboxError("not_found", name);
      const domain = (target: Sandbox) => { try { return target.domain(port); } catch { return undefined; } };
      let url = domain(sandbox);
      if (!url) {
        const current = sandbox;
        const ports = [...new Set([...current.routes.map(route => route.port), port])];
        await call(s => current.update({ ports }, { signal: s }), callOptions.signal);
        sandbox = await fetch(id, callOptions.signal);
        url = sandbox ? domain(sandbox) : undefined;
      }
      if (!url) throw new SandboxError("rejected", name, { code: "port_not_exposed" });
      return { url };
    },

    async startBackground(id, commandLine, execOptions = {}) {
      const sandbox = await handle(id, execOptions.signal);
      const { timeoutMs: _ignored, ...params } = command(commandLine, execOptions);
      // Without a timeout the process runs until the session stops.
      await call(s => sandbox.runCommand({ ...params, ...(execOptions.timeoutMs ? { timeoutMs: execOptions.timeoutMs } : {}), detached: true, signal: s }),
        execOptions.signal);
    },
  });
}
