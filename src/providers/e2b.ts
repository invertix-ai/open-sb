// E2B (e2b.dev): Firecracker microVMs started from templates. Pause keeps memory and disk, named snapshots
// start new sandboxes, ports get HTTPS hosts. Desktop streaming needs a template with the desktop stack (E2B's
// `desktop`: Xvfb, XFCE, x11vnc, noVNC); `desktop()` starts it and returns a password-protected noVNC stream.
// No SSH. A sandbox lives at most 24 hours (1 hour on the Hobby plan) and is killed when its timeout runs out.
// Uses the official `e2b` SDK (a peer dependency).
import { createHash } from "node:crypto";
import {
  AuthenticationError, CommandExitError, FileNotFoundError, GuestUnresponsiveError, InvalidArgumentError,
  NotEnoughSpaceError, NotFoundError, RateLimitError, Sandbox, SandboxError as E2BError, SandboxNotRunningError,
  SandboxUnreachableError, ServiceBusyError, TemplateError, TimeoutError, type SandboxInfo as E2BInfo,
} from "e2b";
import { defineProvider } from "../config.ts";
import { httpError, SandboxError } from "../errors.ts";
import type { ExecOptions, SandboxInfo } from "../types.ts";

export interface E2BOptions {
  /** Default: the SDK reads `E2B_API_KEY`. */
  apiKey?: string;
  /** Template for new sandboxes when `create` names no image. Default: the SDK's `base`. */
  template?: string;
  /** Lifetime given to new and resumed sandboxes. Default 900 s; extend with `setTtl`. */
  ttlSeconds?: number;
  /**
   * Whether port URLs (and so the desktop) open without E2B's traffic token. Default: the project's setting
   * (private for projects created since October 30, 2026). Private sandboxes return the token as a header.
   */
  publicTraffic?: boolean;
  /** Screen size of a desktop that `desktop()` starts. Default [1024, 768]. */
  desktopResolution?: readonly [number, number];
  name?: string;
  /** Override for tests: a substitute for the SDK's `Sandbox` class. */
  Sandbox?: typeof Sandbox;
}

/** E2B accepts lowercase letters, digits and hyphens; other keys are hashed into that alphabet. */
const idempotencyKey = (key: string) => /^[a-z0-9-]{1,255}$/.test(key) ? key : createHash("sha256").update(key).digest("hex");
/** Snapshot names come back as `team-slug/name:tag`; callers know them as `name`. */
const snapshotName = (full: string) => full.replace(/^.*\//, "").replace(/:(latest|default)$/, "");

/** The noVNC (HTML viewer and WebSocket) port, as in E2B's desktop SDK. x11vnc behind it listens on localhost:5900. */
const DESKTOP_PORT = 6080;
/**
 * Starts whatever part of the desktop is not running yet, so it is safe to call again (after a reconnect, a
 * resume or from another process). Every process is detached with no inherited output: an open stdout would
 * keep the command from returning. The VNC password is created once per sandbox, kept 0600 in the sandbox
 * user's home, and is the only thing printed. RFB passwords are 8 characters at most (a protocol limit).
 */
const DESKTOP_SCRIPT = String.raw`set -u
export DISPLAY=:0
command -v Xvfb >/dev/null && command -v x11vnc >/dev/null && [ -x /opt/noVNC/utils/novnc_proxy ] || { echo open-sb:no-desktop; exit 3; }
logs=/tmp/open-sb-desktop; mkdir -p "$logs"
start() { log=$1; shift; setsid "$@" </dev/null >"$logs/$log.log" 2>&1 & }
listening() { (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null; }
if ! xdpyinfo >/dev/null 2>&1; then
  start xvfb Xvfb :0 -ac -screen 0 "$OPEN_SB_SCREEN"x24 -retro -dpi 96 -nolisten tcp -nolisten unix
  for _ in $(seq 100); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
  xdpyinfo >/dev/null 2>&1 || { echo open-sb:no-display; exit 4; }
fi
if command -v startxfce4 >/dev/null && ! pgrep -x xfce4-session >/dev/null; then
  start xfce startxfce4
  for _ in $(seq 150); do pgrep -x xfdesktop >/dev/null && break; sleep 0.2; done
fi
dir=$HOME/.config/open-sb; mkdir -p "$dir"; chmod 700 "$dir"
[ -s "$dir/vnc-password" ] || (umask 077; tr -dc A-Za-z0-9 </dev/urandom | head -c 8 >"$dir/vnc-password")
password=$(cat "$dir/vnc-password")
if ! pgrep -f "x11vnc .*-rfbauth $dir/vnc-passwd" >/dev/null; then
  pgrep -x x11vnc >/dev/null && { echo open-sb:vnc-in-use; exit 5; }
  (umask 077; x11vnc -storepasswd "$password" "$dir/vnc-passwd" >/dev/null 2>&1)
  start x11vnc x11vnc -display :0 -forever -shared -wait 50 -localhost -rfbport 5900 -rfbauth "$dir/vnc-passwd"
  for _ in $(seq 100); do listening 5900 && break; sleep 0.1; done
fi
if ! listening ${DESKTOP_PORT}; then
  start novnc /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen ${DESKTOP_PORT} --web /opt/noVNC
  for _ in $(seq 150); do listening ${DESKTOP_PORT} && break; sleep 0.1; done
fi
listening 5900 && listening ${DESKTOP_PORT} || { echo open-sb:no-stream; exit 6; }
echo "open-sb:password:$password"`;
const DESKTOP_FAILURES: Record<string, string> = {
  "no-desktop": "desktop_not_in_template", "no-display": "desktop_display_failed",
  "vnc-in-use": "desktop_vnc_in_use", "no-stream": "desktop_stream_failed",
};

export function e2b(options: E2BOptions = {}) {
  const name = options.name ?? "e2b";
  const ttlSeconds = options.ttlSeconds ?? 900;
  const SDK = options.Sandbox ?? Sandbox;
  const auth = options.apiKey ? { apiKey: options.apiKey } : {};
  const [screenWidth, screenHeight] = options.desktopResolution ?? [1024, 768];
  if (![screenWidth, screenHeight].every(size => Number.isInteger(size) && size >= 320 && size <= 7680))
    throw new Error("desktopResolution must be two whole numbers from 320 to 7680");
  /** Connected sandboxes, so exec and files skip the connect call. */
  const connected = new Map<string, Sandbox>();

  /** Maps SDK failures onto SandboxError; SDK messages carry provider bodies, so none reach ours. */
  function fail(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted) return signal.reason ?? error;
    if (error instanceof SandboxError) return error;
    if (error instanceof AuthenticationError) return new SandboxError("rejected", name, { status: 401, code: "unauthorized" });
    if (error instanceof RateLimitError) return new SandboxError("unavailable", name, { status: 429, code: "rate_limited" });
    if (error instanceof ServiceBusyError) return new SandboxError("unavailable", name, { status: 503, code: "busy" });
    if (error instanceof FileNotFoundError) return new SandboxError("not_found", name, { code: "file_not_found" });
    if (error instanceof NotFoundError) return new SandboxError("not_found", name, { status: 404 });
    if (error instanceof SandboxNotRunningError) return new SandboxError("not_found", name, { code: "not_running" });
    // Before TimeoutError, its parent: the sandbox or the network between us is down.
    if (error instanceof SandboxUnreachableError) return httpError(name, null, "unreachable");
    if (error instanceof TimeoutError) return new SandboxError("timeout", name, { code: "timeout" });
    if (error instanceof GuestUnresponsiveError) return new SandboxError("rejected", name, { code: "guest_unresponsive" });
    if (error instanceof InvalidArgumentError || error instanceof TemplateError || error instanceof NotEnoughSpaceError)
      return new SandboxError("rejected", name, { status: error.statusCode, code: error.name });
    if (error instanceof E2BError)
      return error.statusCode ? httpError(name, error.statusCode) : new SandboxError("rejected", name, { code: "sdk_error" });
    // The SDK's own request timeout aborts fetch with a DOMException; a failed fetch is a TypeError.
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
      return new SandboxError("timeout", name, { code: "request_timeout" });
    if (error instanceof TypeError) return httpError(name, null, "network");
    return error;
  }

  async function call<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw fail(error, signal);
    }
  }

  /** Runs `work` on a connected sandbox. Connecting resumes a paused one; a stale connection is retried once. */
  async function withSandbox<T>(id: string, signal: AbortSignal | undefined, work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let sandbox = connected.get(id);
      if (!sandbox) {
        sandbox = await call(() => SDK.connect(id, { ...auth, signal }), signal);
        connected.set(id, sandbox);
      }
      try {
        return await work(sandbox);
      } catch (error) {
        if (!(error instanceof SandboxNotRunningError)) throw error;
        connected.delete(id);
        if (attempt > 0 || signal?.aborted) throw fail(error, signal);
      }
    }
  }

  const info = (sandbox: E2BInfo): SandboxInfo => ({
    id: sandbox.sandboxId,
    state: sandbox.state === "running" ? "running" : sandbox.state === "paused" ? "stopped" : "starting",
    labels: { ...sandbox.metadata },
    createdAt: sandbox.startedAt,
    // A paused sandbox has no running timeout.
    expiresAt: sandbox.state === "running" ? sandbox.endAt : undefined,
  });

  async function list(filter: { labels?: Record<string, string>; signal?: AbortSignal } = {}) {
    const wanted = Object.entries(filter.labels ?? {});
    const pages = SDK.list({ ...auth, ...(wanted.length ? { query: { metadata: filter.labels } } : {}) });
    const found: SandboxInfo[] = [];
    while (pages.hasNext) found.push(...(await call(() => pages.nextItems({ ...auth, signal: filter.signal }), filter.signal)).map(info));
    // The API filters already; checking again keeps `list` exact whatever the server matches.
    return found.filter(sandbox => wanted.every(([key, value]) => sandbox.labels[key] === value));
  }

  async function run(id: string, command: string, execOptions: ExecOptions = {}) {
    const { signal } = execOptions;
    return withSandbox(id, signal, async sandbox => {
      try {
        const result = await sandbox.commands.run(command, { cwd: execOptions.cwd, envs: execOptions.env, signal,
          timeoutMs: execOptions.timeoutMs ?? 300_000 });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        // E2B throws on a nonzero exit; open-sb reports it.
        if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        if (error instanceof SandboxNotRunningError) throw error;
        throw fail(error, signal);
      }
    });
  }

  return defineProvider({
    name,
    capabilities: ["pause", "snapshot", "ttl", "ports", "desktop", "background", "persistentDisk"] as const,

    async create(createOptions = {}) {
      const { signal } = createOptions;
      const labels = { ...createOptions.labels };
      const sandbox = await call(() => SDK.create({ ...auth, signal, requestTimeoutMs: 300_000,
        template: createOptions.image ?? options.template, metadata: labels, timeoutMs: ttlSeconds * 1000,
        ...(options.publicTraffic !== undefined ? { network: { allowPublicTraffic: options.publicTraffic } } : {}),
        ...(createOptions.idempotencyKey ? { idempotencyKey: idempotencyKey(createOptions.idempotencyKey) } : {}) }), signal);
      connected.set(sandbox.sandboxId, sandbox);
      const now = Date.now();
      return { id: sandbox.sandboxId, state: "running", labels, createdAt: new Date(now), expiresAt: new Date(now + ttlSeconds * 1000) };
    },

    async get(id, callOptions = {}) {
      try {
        return info(await call(() => SDK.getInfo(id, { ...auth, signal: callOptions.signal }), callOptions.signal));
      } catch (error) {
        if (error instanceof SandboxError && error.kind === "not_found") return null;
        throw error;
      }
    },

    list,

    async destroy(id, callOptions = {}) {
      connected.delete(id);
      // `kill` answers false for a sandbox that is already gone.
      await call(() => SDK.kill(id, { ...auth, signal: callOptions.signal }), callOptions.signal);
    },

    exec: run,

    async readFile(id, path, callOptions = {}) {
      const { signal } = callOptions;
      return withSandbox(id, signal, sandbox => sandbox.files.read(path, { format: "bytes", signal })
        .catch(error => { throw error instanceof SandboxNotRunningError ? error : fail(error, signal); }));
    },

    async writeFile(id, path, data, callOptions = {}) {
      const { signal } = callOptions;
      // The SDK creates missing parent directories.
      await withSandbox(id, signal, sandbox => sandbox.files.write(path, data, { signal })
        .catch(error => { throw error instanceof SandboxNotRunningError ? error : fail(error, signal); }));
    },

    /** Keeps memory and disk; `resume` restores both. */
    async pause(id, callOptions = {}) {
      connected.delete(id);
      await call(() => SDK.pause(id, { ...auth, signal: callOptions.signal, requestTimeoutMs: 300_000 }), callOptions.signal);
    },

    async resume(id, callOptions = {}) {
      const { signal } = callOptions;
      const sandbox = await call(() => SDK.connect(id, { ...auth, signal, requestTimeoutMs: 300_000, timeoutMs: ttlSeconds * 1000 }), signal);
      connected.set(id, sandbox);
    },

    /** E2B pauses the sandbox while it takes the snapshot; the next call reconnects, resuming it if needed. */
    async snapshot(id, snapshot, callOptions = {}) {
      connected.delete(id);
      await call(() => SDK.createSnapshot(id, { ...auth, name: snapshot, signal: callOptions.signal, requestTimeoutMs: 600_000 }), callOptions.signal);
    },

    async listSnapshots(callOptions = {}) {
      const pages = SDK.listSnapshots(auth);
      const names = new Set<string>();
      while (pages.hasNext)
        for (const snapshot of await call(() => pages.nextItems({ ...auth, signal: callOptions.signal }), callOptions.signal))
          for (const full of snapshot.names) names.add(snapshotName(full));
      return [...names];
    },

    /** Deleting a missing snapshot is not an error. */
    async deleteSnapshot(snapshot, callOptions = {}) {
      const { signal } = callOptions;
      const pages = SDK.listSnapshots({ ...auth, name: snapshot });
      const ids: string[] = [];
      while (pages.hasNext)
        for (const found of await call(() => pages.nextItems({ ...auth, signal }), signal))
          if (found.names.some(full => snapshotName(full) === snapshot)) ids.push(found.snapshotId);
      for (const snapshotId of ids) await call(() => SDK.deleteSnapshot(snapshotId, { ...auth, signal }), signal);
    },

    async setTtl(id, seconds, callOptions = {}) {
      await call(() => SDK.setTimeout(id, seconds * 1000, { ...auth, signal: callOptions.signal }), callOptions.signal);
    },

    /** A public HTTPS host. Sandboxes created with restricted public traffic also need the returned header. */
    async portUrl(id, port, callOptions = {}) {
      return withSandbox(id, callOptions.signal, async sandbox => ({
        url: `https://${sandbox.getHost(port)}`,
        ...(sandbox.trafficAccessToken ? { headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken } } : {}),
      }));
    },

    /**
     * Starts the desktop when needed and returns its noVNC stream. The sandbox must be running: viewing does not
     * resume a paused one. Access lasts as long as the sandbox (there is no expiry to renew), and calling again
     * returns the same password, so reconnecting viewers keep working. The password protects the stream; on a
     * private sandbox the traffic token header is needed as well.
     */
    async desktop(id, callOptions = {}) {
      const { signal } = callOptions;
      const state = await call(() => SDK.getInfo(id, { ...auth, signal }), signal);
      if (state.state !== "running") throw new SandboxError("rejected", name, { code: "desktop_requires_running_sandbox" });
      return withSandbox(id, signal, async sandbox => {
        let output: string;
        try {
          output = (await sandbox.commands.run(DESKTOP_SCRIPT, { envs: { OPEN_SB_SCREEN: `${screenWidth}x${screenHeight}` }, signal, timeoutMs: 120_000 })).stdout;
        } catch (error) {
          if (error instanceof SandboxNotRunningError) throw error;
          if (!(error instanceof CommandExitError)) throw fail(error, signal);
          const failure = /open-sb:([a-z-]+)/.exec(error.stdout)?.[1];
          throw new SandboxError(failure === "no-desktop" ? "rejected" : "unavailable", name, { code: DESKTOP_FAILURES[failure ?? ""] ?? "desktop_start_failed",
            message: failure === "no-desktop" ? `${name}: this template has no desktop; create the sandbox from E2B's "desktop" template` : undefined });
        }
        const password = /^open-sb:password:([A-Za-z0-9]{8})$/m.exec(output)?.[1];
        if (!password) throw new SandboxError("unavailable", name, { code: "desktop_start_failed" });
        const host = sandbox.getHost(DESKTOP_PORT);
        // The password goes in the fragment, which browsers never send to the server.
        const url = new URL(`https://${host}/vnc.html`);
        url.search = new URLSearchParams({ autoconnect: "true", resize: "scale", reconnect: "true", view_only: "true", path: "websockify" }).toString();
        url.hash = new URLSearchParams({ password }).toString();
        return {
          url: url.href, websocketUrl: `wss://${host}/websockify`, password,
          ...(sandbox.trafficAccessToken ? { headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken } } : {}),
        };
      });
    },

    async startBackground(id, command, execOptions = {}) {
      const { signal } = execOptions;
      await withSandbox(id, signal, async sandbox => {
        // E2B kills a command when its timeout ends, background ones too (default 60 s): 0 lets it run until the sandbox stops.
        const handle = await sandbox.commands.run(command, { background: true, cwd: execOptions.cwd, envs: execOptions.env, signal, timeoutMs: 0 })
          .catch(error => { throw error instanceof SandboxNotRunningError ? error : fail(error, signal); });
        // Disconnecting stops the event stream without killing the process.
        await handle.disconnect();
      });
    },
  });
}
