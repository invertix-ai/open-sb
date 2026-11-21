// Docker on this machine: each sandbox is a container. For development, tests and self-hosting. Pause stops
// the container (its filesystem is kept), snapshots are `docker commit` images. Needs the `docker` CLI.
import { spawn } from "node:child_process";
import { defineProvider } from "../config.ts";
import { SandboxError } from "../errors.ts";
import type { ExecOptions, ExecResult, SandboxInfo, SandboxState } from "../types.ts";

export interface DockerOptions {
  /** Default image. Default `debian:bookworm-slim`. */
  image?: string;
  /** Extra `docker run` arguments, e.g. `["--memory", "2g"]`. */
  runArgs?: string[];
  name?: string;
  /** The docker binary. Default `docker`. */
  binary?: string;
}

const SNAPSHOTS = "open-sb-snapshot";
const KEY = "open-sb.idempotency-key";
const MANAGED = "open-sb.managed";
const STATES: Record<string, SandboxState> = {
  created: "starting", restarting: "starting", running: "running", paused: "stopped", exited: "stopped", removing: "gone", dead: "gone",
};

export function docker(options: DockerOptions = {}) {
  const name = options.name ?? "docker";
  const binary = options.binary ?? "docker";

  function cli(args: string[], input?: Uint8Array, signal?: AbortSignal, timeoutMs?: number): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((done, fail) => {
      const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], signal, timeout: timeoutMs, killSignal: "SIGKILL" });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout.on("data", chunk => stdout.push(chunk));
      child.stderr.on("data", chunk => stderr.push(chunk));
      child.once("error", error => fail(signal?.aborted ? signal.reason : new SandboxError("unavailable", name, { code: "docker_unavailable", message: `${name}: ${error.message}` })));
      child.once("close", (code, killed) => {
        if (killed === "SIGKILL" && timeoutMs) return fail(new SandboxError("timeout", name, { code: "exec_timeout" }));
        done({ code: code ?? 128, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
      });
      child.stdin.end(input);
    });
  }

  async function docker(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await cli(args, undefined, signal);
    if (result.code !== 0) {
      if (/No such (container|object|image)/i.test(result.stderr)) throw new SandboxError("not_found", name, { code: "not_found" });
      if (/Cannot connect to the Docker daemon|error during connect/i.test(result.stderr)) throw new SandboxError("unavailable", name, { code: "daemon_unreachable" });
      throw new SandboxError("rejected", name, { code: "docker_failed", message: `${name}: docker ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}` });
    }
    return result.stdout.toString().trim();
  }

  /** Containers this provider created; others (and missing ones) are left out. */
  async function inspect(ids: string[], signal?: AbortSignal): Promise<SandboxInfo[]> {
    if (ids.length === 0) return [];
    const parsed = JSON.parse(await docker(["inspect", ...ids], signal)) as {
      Id: string; Created: string; State: { Status: string }; Config: { Labels: Record<string, string> | null } }[];
    return parsed.filter(container => container.Config.Labels?.[MANAGED] === "1").map(container => ({
      id: container.Id.slice(0, 12),
      state: STATES[container.State.Status] ?? "starting",
      labels: Object.fromEntries(Object.entries(container.Config.Labels ?? {}).filter(([key]) => key !== MANAGED)),
      createdAt: new Date(container.Created),
    }));
  }

  async function list(filter: { labels?: Record<string, string>; signal?: AbortSignal } = {}) {
    const filters = [MANAGED, ...Object.entries(filter.labels ?? {}).map(([key, value]) => `${key}=${value}`)]
      .flatMap(label => ["--filter", `label=${label}`]);
    const ids = (await docker(["ps", "-a", "-q", ...filters], filter.signal)).split("\n").filter(Boolean);
    return inspect(ids, filter.signal);
  }

  function execArgs(id: string, execOptions: ExecOptions) {
    return [...(execOptions.cwd ? ["-w", execOptions.cwd] : []),
      ...Object.entries(execOptions.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]), id];
  }

  const snapshotTag = (snapshot: string) => {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(snapshot)) throw new SandboxError("rejected", name, { code: "invalid_snapshot_name" });
    return `${SNAPSHOTS}:${snapshot}`;
  };

  return defineProvider({
    name,
    capabilities: ["pause", "snapshot", "background", "persistentDisk"] as const,

    async create(createOptions = {}) {
      if (createOptions.idempotencyKey) {
        const existing = (await list({ labels: { [KEY]: createOptions.idempotencyKey }, signal: createOptions.signal }))[0];
        if (existing) return existing;
      }
      let image = createOptions.image ?? options.image ?? "debian:bookworm-slim";
      if (createOptions.image && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(createOptions.image)) {
        const snapshot = await cli(["image", "inspect", snapshotTag(createOptions.image)], undefined, createOptions.signal);
        if (snapshot.code === 0) image = snapshotTag(createOptions.image);
      }
      const labels = { ...createOptions.labels, [MANAGED]: "1", ...(createOptions.idempotencyKey ? { [KEY]: createOptions.idempotencyKey } : {}) };
      const id = await docker(["run", "-d", "--init", ...(options.runArgs ?? []),
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        image, "sleep", "infinity"], createOptions.signal);
      return (await inspect([id], createOptions.signal))[0]!;
    },

    async get(id, callOptions = {}) {
      try {
        return (await inspect([id], callOptions.signal))[0] ?? null;
      } catch (error) {
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      try { await docker(["rm", "-f", id], callOptions.signal); }
      catch (error) { if (!(error instanceof SandboxError && error.kind === "not_found")) throw error; }
    },

    async exec(id, command, execOptions = {}): Promise<ExecResult> {
      const result = await cli(["exec", ...execArgs(id, execOptions), "sh", "-c", command], undefined, execOptions.signal, execOptions.timeoutMs);
      return { exitCode: result.code, stdout: result.stdout.toString(), stderr: result.stderr };
    },

    async readFile(id, path, callOptions = {}) {
      const result = await cli(["exec", id, "cat", "--", path], undefined, callOptions.signal);
      if (result.code !== 0) throw new SandboxError("not_found", name, { code: "file_not_found" });
      return new Uint8Array(result.stdout);
    },

    async writeFile(id, path, data, callOptions = {}) {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const result = await cli(["exec", "-i", id, "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], bytes, callOptions.signal);
      if (result.code !== 0) throw new SandboxError("rejected", name, { code: "write_failed" });
    },

    async pause(id, callOptions = {}) {
      await docker(["stop", "-t", "5", id], callOptions.signal);
    },

    async resume(id, callOptions = {}) {
      await docker(["start", id], callOptions.signal);
    },

    async snapshot(id, snapshot, callOptions = {}) {
      await docker(["commit", id, snapshotTag(snapshot)], callOptions.signal);
    },

    async listSnapshots(callOptions = {}) {
      return (await docker(["images", SNAPSHOTS, "--format", "{{.Tag}}"], callOptions.signal)).split("\n").filter(Boolean);
    },

    async deleteSnapshot(snapshot, callOptions = {}) {
      try { await docker(["rmi", snapshotTag(snapshot)], callOptions.signal); }
      catch (error) { if (!(error instanceof SandboxError && error.kind === "not_found")) throw error; }
    },

    async startBackground(id, command, execOptions = {}) {
      await docker(["exec", "-d", ...execArgs(id, execOptions), "sh", "-c", command], execOptions.signal);
    },
  });
}
