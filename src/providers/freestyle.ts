// Freestyle (freestyle.sh): Firecracker VMs for agents, booted from snapshots. Pause keeps memory and disk and
// `start` resumes exactly; `snapshot` captures a VM under a caller-chosen slug that `create({ image })` boots
// from (base images are `freestyle/ubuntu`, `freestyle/busybox` and friends). Labels are native VM metadata
// (up to 64 entries, keys and values at most 63 characters); idempotency keys become the VM's slug. Ports are
// published as free `<name>.style.dev` HTTPS hosts through TLS rules, which die with the VM. Background
// processes run in detached terminal sessions. Every VM gets outbound Internet unless `firewall` says otherwise.
// Freestyle's `ttlSeconds` deletes the VM (not just stops it) a set time after creation.
// Left out: `ssh`, because Freestyle's SSH gateway authenticates with a bearer token in the username, not with
// a caller's public key, and a guest sshd is not reachable over IPv4; `desktop`, because displays are an
// internal, experimental Personal-plan feature. The SDK takes no AbortSignal outside file transfers, so a
// cancelled call returns at once but the request may still finish on Freestyle's side.
// Uses the official `freestyle` SDK (v0.2, a peer dependency).
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  Freestyle, FirewallRuleValidationError, FreestyleApiError, FreestyleTransportError, TlsRuleValidationError,
  type FirewallSpec, type SnapshotData, type Vm, type VmData,
} from "freestyle";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, Labels, SandboxInfo, SandboxState } from "../types.ts";

export interface FreestyleOptions {
  /** Default: the SDK reads `FREESTYLE_API_KEY`. */
  apiKey?: string;
  /** Snapshot new VMs boot from when `create` names no image. Default: the platform's (`freestyle/ubuntu`). */
  image?: string;
  /** Network rules for new VMs. Default: outbound Internet, no direct inbound (ports go through `portUrl`). */
  firewall?: FirewallSpec;
  /** Pause a VM after this many seconds without network activity. Default: never. */
  idleTimeoutSeconds?: number;
  name?: string;
  /** Override for tests: a substitute for the SDK client. */
  client?: FreestyleClientLike;
}

/** The parts of the SDK client used here. */
export type FreestyleClientLike = Pick<Freestyle, "vms" | "tls">;

const STATES: Record<string, SandboxState> = {
  starting: "starting", running: "running", pausing: "stopped", paused: "stopped", stopped: "stopped",
};
const OUTBOUND: FirewallSpec = { rules: [{ action: "allow", source: {}, destination: { public: true } }] };
const PAGE = 100;
const hash = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length);
/** A single-quoted shell word. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function freestyle(options: FreestyleOptions = {}) {
  const name = options.name ?? "freestyle";
  let client = options.client;
  /** Created on first use, so a missing key fails a call (as `rejected`) rather than the import. */
  const sdk = () => client ??= new Freestyle(options.apiKey ? { apiKey: options.apiKey } : {});

  /** Maps SDK failures onto SandboxError; Freestyle's messages never reach ours. */
  function fail(error: unknown): unknown {
    if (error instanceof SandboxError) return error;
    if (error instanceof FreestyleApiError) return httpError(name, error.status, error.code);
    if (error instanceof TlsRuleValidationError || error instanceof FirewallRuleValidationError)
      return new SandboxError("rejected", name, { code: "invalid_request" });
    // A failed fetch is a TypeError (the SDK's FreestyleTransportError is one).
    if (error instanceof FreestyleTransportError || error instanceof TypeError) return httpError(name, null, "network");
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      return new SandboxError("timeout", name, { code: "request_timeout" });
    if (error instanceof Error && error.message.startsWith("Background request temporarily unavailable"))
      return new SandboxError("unavailable", name, { code: "background_poll" });
    if (error instanceof Error && error.message.startsWith("No Freestyle API key"))
      return new SandboxError("rejected", name, { code: "missing_credentials" });
    return error;
  }

  /**
   * Runs one SDK call with a deadline. The SDK cannot cancel most requests, so an abort or the deadline
   * settles this call at once while the request finishes (or not) on Freestyle's side.
   */
  async function call<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = 120_000): Promise<T> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(signal?.aborted ? signal.reason : new SandboxError("timeout", name, { code: "request_timeout" }));
      combined.addEventListener("abort", stop, { once: true });
    });
    try {
      return await Promise.race([(async () => work(combined))(), stopped]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (deadline.aborted) throw new SandboxError("timeout", name, { code: "request_timeout" });
      throw fail(error);
    } finally {
      combined.removeEventListener("abort", stop);
    }
  }

  const vm = (id: string): Vm => sdk().vms.ref(id);

  const info = (data: VmData): SandboxInfo => {
    const createdAt = new Date(data.createdAt);
    return { id: data.id, state: STATES[data.state] ?? "starting", labels: { ...data.metadata }, createdAt,
      expiresAt: data.ttlSeconds != null && data.ttlSeconds >= 0 ? new Date(createdAt.getTime() + data.ttlSeconds * 1000) : undefined };
  };

  /** Fresh record; `null` when the VM does not exist. */
  async function fetch(id: string, signal?: AbortSignal): Promise<VmData | null> {
    try {
      return await call(() => sdk().vms.get(id), signal);
    } catch (error) {
      if (error instanceof SandboxError && error.kind === "not_found") return null;
      throw error;
    }
  }

  async function list(filter: { labels?: Labels } & CallOptions = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    // The API takes `key:value,key:value`; labels containing either separator are only filtered here.
    const metadata = wanted.length && wanted.every(pair => pair.every(part => !/[,:]/.test(part)))
      ? wanted.map(([key, value]) => `${key}:${value}`).join(",") : undefined;
    const found: VmData[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await call(() => sdk().vms.list({ metadata, limit: PAGE, offset }), filter.signal);
      found.push(...page.vms);
      if (page.vms.length < PAGE || found.length >= page.totalCount) break;
    }
    // Checking again keeps `list` exact whatever the server matches.
    return found.map(info).filter(sandbox => wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  /** The command, run in `cwd` when given. Freestyle runs it through the guest's shell. */
  const script = (command: string, cwd?: string) => cwd ? `cd -- ${quote(cwd)} && {\n${command}\n}` : command;

  async function exec(id: string, command: string, execOptions: ExecOptions = {}) {
    const timeoutMs = execOptions.timeoutMs ?? 300_000;
    const result = await call(() => vm(id).exec({ command: script(command, execOptions.cwd), env: execOptions.env, timeoutMs }),
      execOptions.signal, timeoutMs + 60_000);
    // A null status means the command was killed by its timeout.
    if (result.statusCode == null) throw new SandboxError("timeout", name, { code: "command_timeout" });
    return { exitCode: result.statusCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /** Snapshots with this slug, across every page. */
  async function snapshots(signal?: AbortSignal) {
    const found: SnapshotData[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await call(() => sdk().vms.snapshots.list({ limit: PAGE, offset }), signal);
      found.push(...page.snapshots);
      if (page.snapshots.length < PAGE || found.length >= page.totalCount) return found;
    }
  }

  return defineProvider({
    name,
    capabilities: ["pause", "persistentDisk", "snapshot", "ttl", "ports", "background"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      // Slugs are unique per account: an idempotency key becomes the slug, so a retried create finds the first.
      const slug = createOptions.idempotencyKey ? `osb-${hash(createOptions.idempotencyKey, 32)}` : undefined;
      if (slug) {
        const existing = await fetch(slug, signal);
        if (existing) return info(existing);
      }
      const image = createOptions.image ?? options.image;
      try {
        const { data } = await call(() => sdk().vms.create({
          firewall: options.firewall ?? OUTBOUND, metadata: { ...createOptions.labels }, slug,
          ...(image ? { snapshotId: image } : {}),
          ...(options.idleTimeoutSeconds ? { idleTimeoutSeconds: options.idleTimeoutSeconds } : {}),
        }), signal, 300_000);
        return info(data);
      } catch (error) {
        // Two concurrent retries: the loser of the slug race returns the winner's VM.
        if (slug && error instanceof SandboxError && error.status === 409) {
          const existing = await fetch(slug, signal);
          if (existing) return info(existing);
        }
        throw error;
      }
    },

    async get(id, callOptions = {}) {
      const data = await fetch(id, callOptions.signal);
      return data && info(data);
    },

    list,

    async destroy(id, callOptions = {}) {
      // TLS and firewall rules naming the VM are deleted with it.
      try {
        await call(() => sdk().vms.delete(id), callOptions.signal);
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    exec,

    async readFile(id, path, callOptions = {}) {
      return call(signal => vm(id).fs.readFile(path, { signal }), callOptions.signal, 300_000);
    },

    async writeFile(id, path, data, callOptions = {}) {
      const write = () => call(signal => vm(id).fs.writeFile(path, data, { signal }), callOptions.signal, 300_000);
      try {
        await write();
      } catch (error) {
        // A refused write is most often a missing parent directory: create it and try once more.
        if (!(error instanceof SandboxError && (error.kind === "rejected" || error.kind === "not_found"))) throw error;
        const made = await exec(id, `mkdir -p -- ${quote(posix.dirname(path))}`, { signal: callOptions.signal });
        if (made.exitCode !== 0) throw error;
        await write();
      }
    },

    /** Freezes the VM with its memory; `resume` continues exactly where it stopped. */
    async pause(id, callOptions = {}) {
      const data = await fetch(id, callOptions.signal);
      if (!data) throw new SandboxError("not_found", name);
      if (STATES[data.state] === "stopped") return;
      await call(() => vm(id).pause(), callOptions.signal, 300_000);
    },

    async resume(id, callOptions = {}) {
      const data = await fetch(id, callOptions.signal);
      if (!data) throw new SandboxError("not_found", name);
      if (data.state === "running" || data.state === "starting") return;
      await call(() => vm(id).start(), callOptions.signal, 300_000);
    },

    /** Captures memory and disk under the slug `snapshot`; the VM keeps running. */
    async snapshot(id, snapshot, callOptions = {}) {
      await call(() => vm(id).snapshot({ slug: snapshot }), callOptions.signal, 600_000);
    },

    async listSnapshots(callOptions = {}) {
      return (await snapshots(callOptions.signal)).flatMap(snapshot => snapshot.slug ? [snapshot.slug] : []);
    },

    /** Deleting a missing snapshot is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      const { signal } = callOptions;
      for (const found of await snapshots(signal)) {
        if (found.slug !== snapshot) continue;
        try {
          await call(() => sdk().vms.snapshots.delete(found.id), signal);
        } catch (error) {
          if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
        }
      }
    },

    /** Deletes the VM `seconds` from now. Freestyle counts the deadline from creation, so it is converted. */
    async setTtl(id, seconds, callOptions = {}) {
      const data = await fetch(id, callOptions.signal);
      if (!data) throw new SandboxError("not_found", name);
      const age = Math.ceil((Date.now() - new Date(data.createdAt).getTime()) / 1000);
      await call(() => vm(id).update({ ttlSeconds: Math.max(age, 0) + Math.ceil(seconds) }), callOptions.signal);
    },

    /** A public `style.dev` HTTPS host for the port, made once per VM and port; the URL carries no credential. */
    async portUrl(id, port, callOptions = {}) {
      const { signal } = callOptions;
      const existing = async () => {
        const { rules } = await call(() => sdk().tls.rules.list({ vmId: id, limit: PAGE }), signal);
        return rules.find(rule => rule.source.public && rule.destination.port === port && rule.domain.endsWith(".style.dev"))?.domain;
      };
      let domain = await existing();
      if (!domain) {
        domain = `osb-${hash(`${id}:${port}`, 24)}.style.dev`;
        try {
          const rule = { action: "allow", domain, source: { public: true }, destination: { vmId: id, port } } as const;
          await call(() => sdk().tls.rules.create(rule), signal);
        } catch (error) {
          // A concurrent call made the same rule first.
          if (!(error instanceof SandboxError && error.status === 409) || !(domain = await existing())) throw error;
        }
      }
      return { url: `https://${domain}` };
    },

    /** Runs the command in a terminal session and detaches; the session outlives the connection. */
    async startBackground(id, command, execOptions = {}) {
      const env = Object.entries(execOptions.env ?? {});
      for (const [key] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      const exports = env.map(([key, value]) => `export ${key}=${quote(value)}\n`).join("");
      const line = `sh -c ${quote(exports + script(command, execOptions.cwd))}`;
      const session = await call(() => vm(id).pty.open({ exec: line }), execOptions.signal);
      session.detach();
    },
  });
}
