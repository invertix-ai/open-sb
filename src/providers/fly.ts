// Fly.io Machines (fly.io/docs/machines): Firecracker VMs inside one existing Fly app, driven through the
// Machines REST API (there is no official JS SDK). Labels live in machine metadata, which the list endpoint
// filters by exact value. Files move through `exec` as base64 (writes on stdin), because Fly has no file API.
//
// Declared: pause (suspend, then start), persistentDisk (Fly documents that a suspended machine keeps its
// root filesystem, whether start restores the memory snapshot or falls back to a cold boot; `stop` would reset
// it, so pause never stops) and background (`setsid` through exec).
// Left out:
// - ports: Fly has no per-machine HTTPS URL. Public traffic needs an app IP plus a `services` entry per port in
//   the machine config; adding one rewrites the config, which restarts the machine and resets its rootfs.
// - ttl: no lifetime setting; machines run until stopped or destroyed.
// - snapshot: Fly snapshots volumes, not machines; nothing turns a machine into an image `create` could use.
// - ssh: `fly ssh console` goes through Fly's private WireGuard network, with no public host and port.
// - desktop: none.
// Limits: exec runs at most 600 s (a longer `timeoutMs` is rejected) and its output size is capped, so files
// are read in chunks. Fly allows about one request per second per action per machine: 429s are retried here
// (they never ran) rather than reported as an outage. Suspend is only recommended up to 2 GB of memory.
import { createHash } from "node:crypto";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

export interface FlyOptions {
  /** A Fly API token allowed to manage machines in `app` (e.g. `fly tokens create deploy`). */
  apiToken: string;
  /** An existing Fly app the sandboxes live in. */
  app: string;
  /** Fly region code, e.g. `fra`. Default: Fly picks one near the API caller. */
  region?: string;
  /** Default image. Default `debian:bookworm-slim`. */
  image?: string;
  /** Machine size. Default shared CPU, 1 vCPU, 1024 MB (suspend wants 2048 MB or less). */
  guest?: { cpu_kind?: "shared" | "performance"; cpus?: number; memory_mb?: number };
  /** Provider name in errors and reports. Default `fly`. */
  name?: string;
  /** Override for tests. */
  fetch?: typeof fetch;
}

interface Machine { id: string; state: string; created_at?: string; config?: { metadata?: Record<string, unknown> | null } }

const API = "https://api.machines.dev/v1";
const STATES: Record<string, SandboxState> = {
  started: "running", stopped: "stopped", suspended: "stopped", archived: "stopped",
  destroying: "gone", destroyed: "gone", failed: "gone", launch_failed: "gone", replaced: "gone", migrated: "gone",
};
/** Raw bytes per readFile exec and base64 characters per writeFile exec (a multiple of 4). */
const READ_CHUNK = 512 * 1024;
const WRITE_CHUNK = 1024 * 1024;
const MAX_EXEC_SECONDS = 600;
const IDEMPOTENCY_LABEL = "open-sb.idempotency-key";
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
});

export function fly(options: FlyOptions) {
  const name = options.name ?? "fly";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const machines = `${API}/apps/${encodeURIComponent(options.app)}/machines`;
  const machine = (id: string) => `${machines}/${encodeURIComponent(id)}`;

  async function request<T>(url: string, init: { method: string; body?: unknown; timeoutMs?: number } & CallOptions): Promise<{ value: T; headers: Headers }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.apiToken}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(init.timeoutMs ?? 60_000);
      let response: Response;
      try {
        response = await fetchImpl(url, { method: init.method, headers, redirect: "error",
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason ?? error;
        if (timeout.aborted) throw new SandboxError("timeout", name, { code: "request_timeout" });
        throw httpError(name, null, "network");
      }
      const value: unknown = await response.json().catch(() => undefined);
      if (response.ok) {
        if (value === undefined && init.method !== "DELETE") throw new SandboxError("unavailable", name, { status: response.status, code: "invalid_response" });
        return { value: value as T, headers: response.headers };
      }
      const seconds = Number(response.headers.get("retry-after") ?? "");
      const retryAfter = Number.isFinite(seconds) && seconds >= 0 && response.headers.has("retry-after") ? seconds : undefined;
      // Per-machine rate limits are tight (about 1/s per action); a 429 was not executed, so waiting is safe.
      if (response.status === 429 && attempt < 6) { await sleep((retryAfter ?? attempt) * 1000, init.signal); continue; }
      const status = (value as { status?: unknown } | undefined)?.status;
      throw httpError(name, response.status, typeof status === "string" ? status : undefined, retryAfter);
    }
  }

  const info = (record: Machine): SandboxInfo => {
    const metadata = Object.entries(record.config?.metadata ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return {
      id: record.id,
      state: STATES[record.state] ?? "starting",
      // Fly keeps its own `fly_*` keys (process group, platform version) in metadata; they are not labels.
      labels: Object.fromEntries(metadata.filter(([key]) => !key.startsWith("fly_"))),
      createdAt: record.created_at ? new Date(record.created_at) : undefined,
    };
  };

  async function list(filter: { labels?: Labels } & CallOptions = {}): Promise<SandboxInfo[]> {
    const wanted = Object.entries(filter.labels ?? {});
    const found: SandboxInfo[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams(wanted.map(([key, value]) => [`metadata.${key}`, value]));
      if (cursor) query.set("cursor", cursor);
      const page: { value: Machine[]; headers: Headers } = await request<Machine[]>(`${machines}${query.size ? `?${query}` : ""}`, { method: "GET", signal: filter.signal });
      // The server filter is exact; filtering again keeps that true whatever the server returns.
      for (const record of page.value)
        if (wanted.every(([key, value]) => record.config?.metadata?.[key] === value)) found.push(info(record));
      cursor = page.headers.get("fly-next-cursor");
    } while (cursor);
    return found;
  }

  async function run(id: string, command: string, execOptions: ExecOptions = {}, stdin?: string) {
    const env = Object.entries(execOptions.env ?? {});
    for (const [key] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const seconds = Math.max(1, Math.ceil((execOptions.timeoutMs ?? 300_000) / 1000));
    if (seconds > MAX_EXEC_SECONDS) throw new SandboxError("rejected", name, { code: "exec_timeout_too_long", message: `${name}: exec timeout is at most ${MAX_EXEC_SECONDS} s` });
    const prefix = [...env.map(([key, value]) => `export ${key}=${quote(value)}`), ...(execOptions.cwd ? [`cd ${quote(execOptions.cwd)}`] : [])];
    const full = prefix.length ? `${prefix.join(" && ")} && ${command}` : command;
    // `command` runs without a shell, so the shell is explicit. The request outlives the command by a margin,
    // so Fly reports the timeout rather than the connection dropping.
    const { value } = await request<{ exit_code?: number; exit_signal?: number; stdout?: string; stderr?: string }>(`${machine(id)}/exec`, {
      method: "POST", signal: execOptions.signal, timeoutMs: seconds * 1000 + 30_000,
      body: { command: ["/bin/sh", "-c", full], timeout: seconds, ...(stdin === undefined ? {} : { stdin }) } });
    const signal = typeof value.exit_signal === "number" && value.exit_signal > 0 ? value.exit_signal : 0;
    return { exitCode: signal ? 128 + signal : value.exit_code ?? 128, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
  }

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "background"] as const,

    async create(createOptions = {}) {
      const labels = { ...createOptions.labels, ...(createOptions.idempotencyKey ? { [IDEMPOTENCY_LABEL]: createOptions.idempotencyKey } : {}) };
      const body = {
        region: options.region,
        // Machine names are unique within an app, so a retried create with the same key fails with `name_taken`.
        name: createOptions.idempotencyKey ? `open-sb-${createHash("sha256").update(createOptions.idempotencyKey).digest("hex").slice(0, 32)}` : undefined,
        config: {
          image: createOptions.image ?? options.image ?? "debian:bookworm-slim",
          // Base images exit at once without a terminal; keep the VM up whatever the image's command is.
          init: { exec: ["/bin/sleep", "inf"] },
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024, ...options.guest },
          metadata: labels,
          auto_destroy: false,
        },
      };
      try {
        const { value } = await request<Machine>(machines, { method: "POST", body, timeoutMs: 300_000, signal: createOptions.signal });
        return info(value);
      } catch (error) {
        if (!createOptions.idempotencyKey || !(error instanceof SandboxError && error.kind === "rejected")) throw error;
        const existing = (await list({ labels: { [IDEMPOTENCY_LABEL]: createOptions.idempotencyKey }, signal: createOptions.signal }))
          .find(sandbox => sandbox.state !== "gone");
        if (existing) return existing;
        throw error;
      }
    },

    async get(id, callOptions = {}) {
      try {
        return info((await request<Machine>(machine(id), { method: "GET", signal: callOptions.signal })).value);
      } catch (error) {
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      try {
        await request(`${machine(id)}?force=true`, { method: "DELETE", signal: callOptions.signal });
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    exec: (id, command, execOptions) => run(id, command, execOptions),

    async readFile(id, path, callOptions = {}) {
      const size = await run(id, `wc -c < ${quote(path)}`, callOptions);
      if (size.exitCode !== 0) throw new SandboxError("not_found", name, { code: "file_not_found" });
      const total = Number(size.stdout.trim());
      const parts: Buffer[] = [];
      for (let offset = 0; offset === 0 || offset < total; offset += READ_CHUNK) {
        const chunk = await run(id, `tail -c +${offset + 1} -- ${quote(path)} | head -c ${READ_CHUNK} | base64 | tr -d '\\n'`, callOptions);
        if (chunk.exitCode !== 0) throw new SandboxError("rejected", name, { code: "read_failed" });
        parts.push(Buffer.from(chunk.stdout.trim(), "base64"));
      }
      return new Uint8Array(Buffer.concat(parts));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const encoded = Buffer.from(typeof data === "string" ? Buffer.from(data) : data).toString("base64");
      const temporary = quote(`${path}.open-sb-${Date.now()}`);
      const steps: [string, string?][] = [[`mkdir -p -- "$(dirname -- ${quote(path)})" && : > ${temporary}`]];
      for (let offset = 0; offset < encoded.length; offset += WRITE_CHUNK)
        steps.push([`base64 -d >> ${temporary}`, encoded.slice(offset, offset + WRITE_CHUNK)]);
      steps.push([`mv -f ${temporary} ${quote(path)}`]);
      for (const [command, stdin] of steps) {
        const result = await run(id, command, callOptions, stdin);
        if (result.exitCode !== 0) throw new SandboxError("rejected", name, { code: "write_failed" });
      }
    },

    /** Suspend, never stop: stopping resets the root filesystem to the image. */
    async pause(id, callOptions = {}) {
      await request(`${machine(id)}/suspend`, { method: "POST", signal: callOptions.signal });
    },

    async resume(id, callOptions = {}) {
      await request(`${machine(id)}/start`, { method: "POST", signal: callOptions.signal });
    },

    async startBackground(id, command, execOptions = {}) {
      const result = await run(id, `setsid -f /bin/sh -c ${quote(command)} < /dev/null > /dev/null 2>&1`, execOptions);
      if (result.exitCode !== 0) throw new SandboxError("rejected", name, { code: "background_start_failed" });
    },
  });
}
