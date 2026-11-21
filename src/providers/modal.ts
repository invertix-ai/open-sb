// Modal (modal.com): gVisor containers that boot in about a second, grouped under a Modal App. Uses the
// official `modal` JS SDK (an optional peer dependency). Limits: no pause (only an experimental persistent
// mode this provider does not use), no SSH, no desktop, and a lifetime fixed at creation (no `ttl`: Modal
// cannot extend it and the SDK does not report when it ends). A sandbox stops for good when its lifetime
// runs out. Labels are Modal sandbox tags; `list` returns running sandboxes only.
//
// Ports: a port listed in `encryptedPorts` gets a TLS tunnel declared at creation, and `portUrl` returns its
// public (unguessable but unauthenticated) URL. Any other port is reached through a connect token: a private
// URL plus an `Authorization` header that must stay server-side.
//
// Snapshots: a filesystem snapshot published as a named Modal Image, `<snapshotImage>:<name>`, kept until
// `deleteSnapshot`. Listing and deleting names use the SDK's gRPC client directly (`imageListTags`,
// `imageNameDelete`), which the SDK does not wrap yet.
import {
  ModalClient, NotFoundError, InvalidError, AlreadyExistsError, ConflictError, ResourceExhaustedError, InternalFailure,
  RemoteError, TimeoutError, SandboxTimeoutError, SandboxFilesystemError, SandboxFilesystemNotFoundError, ClientClosedError,
  type App, type Image, type Sandbox,
} from "modal";
import { defineProvider } from "../config.ts";
import { SandboxError } from "../errors.ts";
import type { CallOptions, ExecOptions, SandboxInfo } from "../types.ts";

export interface ModalOptions {
  /** Default: `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` or the `~/.modal.toml` profile, as the SDK resolves them. */
  tokenId?: string;
  tokenSecret?: string;
  /** Modal environment. Default: the profile's. */
  environment?: string;
  /** A configured client; replaces the token options. The provider never closes it. */
  client?: ModalClient;
  /** App that owns the sandboxes, created if missing. Default `open-sb`. */
  appName?: string;
  /** Registry image for `create()` without `image`. Default `python:3.13-slim`. */
  image?: string;
  /** Lifetime of each sandbox; Modal terminates it afterwards. Default 1 hour (Modal allows up to 24). */
  timeoutMs?: number;
  /** Idle time after which Modal terminates a sandbox. Default: none. */
  idleTimeoutMs?: number;
  /** Ports given a public TLS tunnel at creation. Other ports use private connect tokens. */
  encryptedPorts?: number[];
  /** Image name under which snapshots are published as tags. Default `open-sb-snapshots`. */
  snapshotImage?: string;
  name?: string;
}

const IDEMPOTENCY_TAG = "open-sb.idempotency-key";
/** Modal object names: letters, digits, `-`, `.`, `_`, under 64 characters. */
const OBJECT_NAME = /^[A-Za-z0-9._-]{1,63}$/;
/** gRPC status codes (nice-grpc `Status`) and what they mean here. */
const GRPC: Record<number, [string, SandboxError["kind"]]> = {
  1: ["CANCELLED", "unavailable"], 2: ["UNKNOWN", "unavailable"], 3: ["INVALID_ARGUMENT", "rejected"],
  4: ["DEADLINE_EXCEEDED", "timeout"], 5: ["NOT_FOUND", "not_found"], 6: ["ALREADY_EXISTS", "rejected"],
  7: ["PERMISSION_DENIED", "rejected"], 8: ["RESOURCE_EXHAUSTED", "unavailable"], 9: ["FAILED_PRECONDITION", "rejected"],
  10: ["ABORTED", "unavailable"], 11: ["OUT_OF_RANGE", "rejected"], 12: ["UNIMPLEMENTED", "rejected"],
  13: ["INTERNAL", "unavailable"], 14: ["UNAVAILABLE", "unavailable"], 15: ["DATA_LOSS", "unavailable"], 16: ["UNAUTHENTICATED", "rejected"],
};

export function modal(options: ModalOptions = {}) {
  const name = options.name ?? "modal";
  const appName = options.appName ?? "open-sb";
  const snapshotImage = options.snapshotImage ?? "open-sb-snapshots";
  const encryptedPorts = options.encryptedPorts ?? [];
  const environment = options.environment;
  let client = options.client;
  const sdk = () => client ??= new ModalClient({ tokenId: options.tokenId, tokenSecret: options.tokenSecret, environment });
  let app: Promise<App> | undefined;
  const getApp = () => app ??= sdk().apps.fromName(appName, { environment, createIfMissing: true })
    .catch(error => { app = undefined; throw error; });

  /** Maps SDK failures onto SandboxError; Modal's messages (which may echo server details) are dropped. */
  function mapError(error: unknown): unknown {
    if (error instanceof SandboxError) return error;
    const of = (kind: SandboxError["kind"], code: string) => new SandboxError(kind, name, { code });
    if (error instanceof SandboxFilesystemNotFoundError) return of("not_found", "file_not_found");
    if (error instanceof SandboxFilesystemError) return of("rejected", "filesystem_error");
    if (error instanceof NotFoundError) return of("not_found", "not_found");
    if (error instanceof ResourceExhaustedError) return of("unavailable", "resource_exhausted");
    if (error instanceof InternalFailure || error instanceof RemoteError) return of("unavailable", "internal");
    if (error instanceof TimeoutError || error instanceof SandboxTimeoutError) return of("timeout", "timeout");
    if (error instanceof InvalidError) return of("rejected", "invalid");
    if (error instanceof AlreadyExistsError || error instanceof ConflictError) return of("rejected", "conflict");
    if (error instanceof ClientClosedError) return of("rejected", "client_closed");
    // Raw gRPC failures (nice-grpc `ClientError`) the SDK lets through.
    const grpc = error as { name?: unknown; code?: unknown };
    if (grpc?.name === "ClientError" && typeof grpc.code === "number") {
      const [code, kind] = GRPC[grpc.code] ?? ["UNKNOWN", "unavailable"];
      return of(kind, code);
    }
    // Node socket errors (ECONNRESET, ENOTFOUND, ...) before any gRPC status.
    if (typeof grpc?.code === "string" && /^E[A-Z]+$/.test(grpc.code)) return of("unavailable", "network");
    return error;
  }

  /** Runs SDK work under a deadline and the caller's signal. The SDK takes no signal, so an abandoned call may still finish on Modal. */
  async function call<T>(work: () => Promise<T>, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let onAbort = () => {};
    const aborted = new Promise<never>((_, fail) => {
      onAbort = () => fail(signal?.aborted ? signal.reason : new SandboxError("timeout", name, { code: "request_timeout" }));
      stop.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work(), aborted]);
    } catch (error) {
      throw mapError(error);
    } finally {
      stop.removeEventListener("abort", onAbort);
    }
  }

  const sandbox = (id: string) => sdk().sandboxes.fromId(id);

  async function describe(box: Sandbox): Promise<SandboxInfo | null> {
    try {
      const [exitCode, labels] = await Promise.all([box.poll(), box.getTags()]);
      return { id: box.sandboxId, state: exitCode === null ? "running" : "gone", labels };
    } catch (error) {
      const mapped = mapError(error);
      if (mapped instanceof SandboxError && mapped.kind === "not_found") return null;
      throw mapped;
    }
  }

  async function list(filter: { labels?: Record<string, string> } & CallOptions = {}) {
    return call(async () => {
      const wanted = Object.entries(filter.labels ?? {});
      const found: SandboxInfo[] = [];
      const { appId } = await getApp();
      for await (const box of sdk().sandboxes.list({ appId, environment, ...(wanted.length ? { tags: filter.labels } : {}) })) {
        const info = await describe(box);
        // Modal filters on the server; checking again keeps `list` exact if that ever loosens.
        if (info && wanted.every(([key, value]) => info.labels[key] === value)) found.push(info);
      }
      return found;
    }, filter.signal, 120_000);
  }

  /** `im-...` is an image ID; a bare name is a snapshot if one exists, otherwise a registry image like `ubuntu`. */
  async function resolveImage(image: string | undefined): Promise<Image> {
    const images = sdk().images;
    if (!image) return images.fromRegistry(options.image ?? "python:3.13-slim");
    if (image.startsWith("im-")) return images.fromId(image);
    if (OBJECT_NAME.test(image)) {
      try {
        return await images.fromName(`${snapshotImage}:${image}`, { environment });
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return images.fromRegistry(image);
  }

  async function exec(id: string, command: string, execOptions: ExecOptions = {}) {
    const timeoutMs = Math.ceil((execOptions.timeoutMs ?? 600_000) / 1000) * 1000;
    return call(async () => {
      const started = Date.now();
      const child = await (await sandbox(id)).exec(["sh", "-c", command],
        { workdir: execOptions.cwd, env: execOptions.env, timeoutMs });
      const [stdout, stderr, exitCode] = await Promise.all([child.stdout.readText(), child.stderr.readText(), child.wait()]);
      // Modal reports its own exec timeout as exit code 124.
      if (exitCode === 124 && Date.now() - started >= timeoutMs) throw new SandboxError("timeout", name, { code: "exec_timeout" });
      return { exitCode, stdout, stderr };
    }, execOptions.signal, timeoutMs + 30_000);
  }

  const snapshotRef = (snapshot: string) => `${snapshotImage}:${snapshot}`;

  return defineProvider({
    name,
    capabilities: ["snapshot", "ports", "background"] as const,

    async create(createOptions = {}) {
      // Modal has no idempotency key: a retried create looks for a running sandbox carrying the same key first.
      if (createOptions.idempotencyKey) {
        const existing = await list({ labels: { [IDEMPOTENCY_TAG]: createOptions.idempotencyKey }, signal: createOptions.signal });
        if (existing[0]) return existing[0];
      }
      const tags = { ...createOptions.labels, ...(createOptions.idempotencyKey ? { [IDEMPOTENCY_TAG]: createOptions.idempotencyKey } : {}) };
      return call(async () => {
        const [owner, image] = await Promise.all([getApp(), resolveImage(createOptions.image)]);
        const box = await sdk().sandboxes.create(owner, image, {
          timeoutMs: options.timeoutMs ?? 3_600_000, idleTimeoutMs: options.idleTimeoutMs,
          encryptedPorts: encryptedPorts.length ? encryptedPorts : undefined, tags,
        });
        return { id: box.sandboxId, state: "running" as const, labels: tags };
      }, createOptions.signal, 600_000);
    },

    async get(id, callOptions = {}) {
      return call(async () => describe(await sandbox(id)), callOptions.signal);
    },

    list,

    async destroy(id, callOptions = {}) {
      try {
        await call(async () => (await sandbox(id)).terminate(), callOptions.signal);
      } catch (error) {
        if (!(error instanceof SandboxError && error.kind === "not_found")) throw error;
      }
    },

    exec,

    async readFile(id, path, callOptions = {}) {
      return call(async () => (await sandbox(id)).filesystem.readBytes(path), callOptions.signal, 300_000);
    },

    async writeFile(id, path, data, callOptions = {}) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      await call(async () => (await sandbox(id)).filesystem.writeBytes(bytes, path), callOptions.signal, 300_000);
    },

    async snapshot(id, snapshot, callOptions = {}) {
      if (!OBJECT_NAME.test(snapshot)) throw new SandboxError("rejected", name, { code: "invalid_snapshot_name" });
      await call(async () => {
        // Kept until deleteSnapshot (Modal's default would expire it after 30 days).
        const image = await (await sandbox(id)).snapshotFilesystem({ timeoutMs: 300_000, ttlMs: null });
        await image.publish(snapshotRef(snapshot), { environment });
      }, callOptions.signal, 330_000);
    },

    async listSnapshots(callOptions = {}) {
      return call(async () => {
        const names: string[] = [];
        const prefix = snapshotRef("");
        let pageToken = "";
        do {
          const page = await sdk().cpClient.imageListTags({ environmentName: sdk().environmentName(environment),
            tagPrefix: prefix, maxObjects: 100, pageToken }, { signal: callOptions.signal });
          // Items carry the full `name:tag`; keep only the tag.
          for (const item of page.items) if (item.tag.startsWith(prefix)) names.push(item.tag.slice(prefix.length));
          pageToken = page.nextPageToken;
        } while (pageToken);
        return names;
      }, callOptions.signal);
    },

    async deleteSnapshot(snapshot, callOptions = {}) {
      if (!OBJECT_NAME.test(snapshot)) throw new SandboxError("rejected", name, { code: "invalid_snapshot_name" });
      await call(async () => {
        let image: Image;
        try {
          image = await sdk().images.fromName(snapshotRef(snapshot), { environment });
        } catch (error) {
          if (error instanceof NotFoundError) return; // already gone
          throw error;
        }
        await sdk().cpClient.imageNameDelete({ tag: `${environment ? `${environment}/` : ""}${snapshotRef(snapshot)}` },
          { signal: callOptions.signal });
        await sdk().images.delete(image.imageId).catch(error => { if (!(error instanceof NotFoundError)) throw error; });
      }, callOptions.signal);
    },

    async portUrl(id, port, callOptions = {}) {
      return call(async () => {
        const box = await sandbox(id);
        if (encryptedPorts.includes(port)) {
          const tunnel = (await box.tunnels(50_000))[port];
          if (!tunnel) throw new SandboxError("unavailable", name, { code: "tunnel_missing" });
          return { url: tunnel.url };
        }
        const credentials = await box.createConnectToken({ port });
        if (!credentials.url.startsWith("https://")) throw new SandboxError("unavailable", name, { code: "port_url_not_https" });
        return { url: credentials.url, headers: { Authorization: `Bearer ${credentials.token}` } };
      }, callOptions.signal);
    },

    /** Starts the command and returns once it runs; output is discarded so the process never blocks on a full pipe. */
    async startBackground(id, command, execOptions = {}) {
      await call(async () => {
        await (await sandbox(id)).exec(["sh", "-c", command], { workdir: execOptions.cwd, env: execOptions.env, stdout: "ignore", stderr: "ignore" });
      }, execOptions.signal);
    },
  });
}
