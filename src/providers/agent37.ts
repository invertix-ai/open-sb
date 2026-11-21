// Agent37 (agent37.com): VMs that sleep when idle and wake on the next request. No SSH, no desktop and no
// file API: files move through `exec` as base64. Ports are reached through short-lived signed URLs.
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, SandboxInfo, SandboxState } from "../types.ts";

export interface Agent37Options {
  apiKey: string;
  /** Instance template. Default `agent37-hermes` (Debian with Node, Python and Chromium). */
  template?: string;
  /** `eu` requires `type: "vm"`. */
  region?: string;
  type?: "vm" | "container";
  resources?: { cpu: number; memory: number; disk: number };
  /** Idle seconds before the instance sleeps on its own. */
  idleTimeoutSeconds?: number;
  /** Lifetime of signed port URLs (seconds). Default 60. */
  portUrlTtlSeconds?: number;
  name?: string;
  /** Override for tests. */
  fetch?: typeof fetch;
}

interface Instance { id: string; status: string; metadata?: Record<string, unknown> | null; created?: number }

const API = "https://api.agent37.com/v1";
const SANDBOX = "https://sandbox.agent37.app/v1";
const STATES: Record<string, SandboxState> = {
  running: "running", sleeping: "stopped", stopped: "stopped", failed: "gone", deleting: "gone", deleted: "gone",
};
const CHUNK = 48 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function agent37(options: Agent37Options) {
  const name = options.name ?? "agent37";
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request<T>(url: string, init: { method: string; body?: unknown; sandbox?: boolean; timeoutMs?: number } & CallOptions): Promise<T> {
    const headers: Record<string, string> = init.sandbox ? { "X-Agent37-Key": options.apiKey } : { Authorization: `Bearer ${options.apiKey}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
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
      return value as T;
    }
    const error = (value as { error?: unknown } | undefined)?.error;
    const code = typeof error === "string" ? error : typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
    throw httpError(name, response.status, code);
  }

  const info = (instance: Instance): SandboxInfo => ({
    id: instance.id,
    state: STATES[instance.status] ?? "starting",
    labels: Object.fromEntries(Object.entries(instance.metadata ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    createdAt: typeof instance.created === "number" ? new Date(instance.created * 1000) : undefined,
  });

  async function exec(id: string, command: string, execOptions: ExecOptions = {}, background = false) {
    const env = Object.entries(execOptions.env ?? {});
    for (const [key] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const prefix = [...env.map(([key, value]) => `export ${key}=${quote(value)}`), ...(execOptions.cwd ? [`cd ${quote(execOptions.cwd)}`] : [])];
    const full = prefix.length ? `${prefix.join(" && ")} && ${command}` : command;
    return request<{ exit_code?: number; stdout?: string; stderr?: string }>(`${SANDBOX}/instances/${encodeURIComponent(id)}/exec`,
      { method: "POST", sandbox: true, body: { command: full, background }, timeoutMs: execOptions.timeoutMs ?? 300_000, signal: execOptions.signal });
  }

  async function run(id: string, command: string, execOptions: ExecOptions = {}) {
    const result = await exec(id, command, execOptions);
    return { exitCode: result.exit_code ?? 128, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  async function list(filter: { labels?: Record<string, string> } & CallOptions = {}) {
    const page = await request<{ data: Instance[]; has_more?: unknown; next_cursor?: unknown }>(`${API}/instances`, { method: "GET", signal: filter.signal });
    // Paging is not documented; a partial list would hide sandboxes, so refuse it.
    if (page.has_more === true || (page.next_cursor !== undefined && page.next_cursor !== null))
      throw new SandboxError("unavailable", name, { code: "list_incomplete" });
    const wanted = Object.entries(filter.labels ?? {});
    return page.data.map(info).filter(sandbox => wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  return defineProvider({
    name,
    capabilities: ["pause", "ports", "background", "persistentDisk"] as const,

    async create(createOptions = {}) {
      if (createOptions.image && createOptions.image !== (options.template ?? "agent37-hermes"))
        throw new SandboxError("rejected", name, { code: "image_not_supported" });
      // Agent37 has no idempotency key: a retried create looks for an instance carrying the same key first.
      const labels = { ...createOptions.labels, ...(createOptions.idempotencyKey ? { "open-sb.idempotency-key": createOptions.idempotencyKey } : {}) };
      if (createOptions.idempotencyKey) {
        const existing = (await list({ labels: { "open-sb.idempotency-key": createOptions.idempotencyKey }, signal: createOptions.signal }))
          .find(sandbox => sandbox.state !== "gone");
        if (existing) return existing;
      }
      const created = await request<Instance>(`${API}/instances`, { method: "POST", timeoutMs: 300_000, signal: createOptions.signal, body: {
        template: options.template ?? "agent37-hermes", type: options.type ?? "vm", region: options.region ?? "eu",
        resources: options.resources ?? { cpu: 2, memory: 4, disk: 8 }, metadata: labels,
        auto_sleep: true, idle_timeout_seconds: options.idleTimeoutSeconds ?? 300 } });
      return info(created);
    },

    async get(id, callOptions = {}) {
      try {
        const instance = await request<Instance>(`${API}/instances/${encodeURIComponent(id)}`, { method: "GET", signal: callOptions.signal });
        return info(instance);
      } catch (error) {
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      try {
        await request(`${API}/instances/${encodeURIComponent(id)}`, { method: "DELETE", signal: callOptions.signal });
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    exec: run,

    async readFile(id, path, callOptions = {}) {
      const result = await run(id, `base64 -w0 -- ${quote(path)}`, callOptions);
      if (result.exitCode !== 0) throw new SandboxError("not_found", name, { code: "file_not_found" });
      return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const encoded = Buffer.from(typeof data === "string" ? Buffer.from(data) : data).toString("base64");
      const temporary = `${path}.open-sb-${Date.now()}`;
      const steps = [`mkdir -p -- "$(dirname -- ${quote(path)})" && : > ${quote(temporary)}`];
      for (let offset = 0; offset < encoded.length; offset += CHUNK)
        steps.push(`printf %s ${quote(encoded.slice(offset, offset + CHUNK))} >> ${quote(temporary)}`);
      steps.push(`base64 -d ${quote(temporary)} > ${quote(temporary)}.out && mv -f ${quote(temporary)}.out ${quote(path)} && rm -f ${quote(temporary)}`);
      for (const step of steps) {
        const result = await run(id, step, callOptions);
        if (result.exitCode !== 0) throw new SandboxError("rejected", name, { code: "write_failed" });
      }
    },

    async pause(id, callOptions = {}) {
      await request(`${API}/instances/${encodeURIComponent(id)}/sleep`, { method: "POST", signal: callOptions.signal });
    },

    /** Any request to the instance wakes it; this waits until it answers its health check. */
    async resume(id, callOptions = {}) {
      const until = Date.now() + 300_000;
      for (;;) {
        callOptions.signal?.throwIfAborted();
        const health = await request<{ healthy?: unknown }>(`https://${encodeURIComponent(id)}.agent37.app/v1/health`,
          { method: "GET", sandbox: true, timeoutMs: 200_000, signal: callOptions.signal }).catch(() => undefined);
        if (health?.healthy === true) return;
        if (Date.now() > until) throw new SandboxError("timeout", name, { code: "wake_timeout" });
        await new Promise(done => setTimeout(done, 1_000));
      }
    },

    async portUrl(id, port, callOptions = {}) {
      const signed = await request<{ url: string }>(`${API}/instances/${encodeURIComponent(id)}/signed-url`,
        { method: "POST", signal: callOptions.signal, body: { port, ttl_seconds: options.portUrlTtlSeconds ?? 60 } });
      return { url: signed.url };
    },

    async startBackground(id, command, execOptions = {}) {
      const result = await exec(id, command, execOptions, true);
      if (typeof result.exit_code === "number" && result.exit_code !== 0)
        throw new SandboxError("rejected", name, { code: "background_start_failed" });
    },
  });
}
