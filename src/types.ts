// The provider contract: a small core every sandbox has, plus optional capabilities. A provider lists the
// capabilities it implements in `capabilities`, and the type system then requires their methods.

/** Labels are plain key/value strings; providers use them to find and filter sandboxes. */
export type Labels = Record<string, string>;

/** Normalized lifecycle. `gone` means deleted, failed or otherwise unrecoverable. */
export type SandboxState = "starting" | "running" | "stopped" | "gone";

export interface SandboxInfo {
  id: string;
  state: SandboxState;
  labels: Labels;
  createdAt?: Date;
  /** When the provider will stop the sandbox on its own (`ttl` capability). */
  expiresAt?: Date;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface CreateOptions extends CallOptions {
  /** Provider image, template or snapshot name. Omitted: the provider's default image. */
  image?: string;
  labels?: Labels;
  /** Same key, same sandbox: lets a caller retry a create whose response was lost. */
  idempotencyKey?: string;
}

export interface ExecOptions extends CallOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** What every provider implements. */
export interface Core {
  create(options?: CreateOptions): Promise<SandboxInfo>;
  /** `null` when the sandbox no longer exists. */
  get(id: string, options?: CallOptions): Promise<SandboxInfo | null>;
  list(filter?: { labels?: Labels } & CallOptions): Promise<SandboxInfo[]>;
  destroy(id: string, options?: CallOptions): Promise<void>;
  exec(id: string, command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(id: string, path: string, options?: CallOptions): Promise<Uint8Array>;
  writeFile(id: string, path: string, data: Uint8Array | string, options?: CallOptions): Promise<void>;
}

/** Sleep and wake. A paused sandbox costs little and keeps its identity. */
export interface Pause {
  pause(id: string, options?: CallOptions): Promise<void>;
  resume(id: string, options?: CallOptions): Promise<void>;
}

/** Save a sandbox as a named image; `create({ image: name })` starts new sandboxes from it. */
export interface Snapshot {
  snapshot(id: string, name: string, options?: CallOptions): Promise<void>;
  listSnapshots(options?: CallOptions): Promise<string[]>;
  deleteSnapshot(name: string, options?: CallOptions): Promise<void>;
}

/** The provider stops the sandbox on its own after a lifetime the caller sets and extends. */
export interface Ttl {
  setTtl(id: string, seconds: number, options?: CallOptions): Promise<void>;
}

/** An HTTPS address for a port inside the sandbox. Private addresses carry a credential: keep them server-side. */
export interface Ports {
  portUrl(id: string, port: number, options?: CallOptions): Promise<{ url: string; headers?: Record<string, string> }>;
}

/** SSH access with a pinned host key. */
export interface Ssh {
  ssh(id: string, publicKey: string, options?: CallOptions): Promise<{ host: string; port: number; user: string; hostKey?: string }>;
}

/** A graphical desktop a person can watch, as a (secret) viewer URL. */
export interface Desktop {
  desktop(id: string, options?: CallOptions): Promise<{ url: string } | { provisioning: true }>;
}

/** A process that keeps running after the call returns, until the sandbox stops. */
export interface Background {
  startBackground(id: string, command: string, options?: ExecOptions): Promise<void>;
}

/** Each capability and the methods it requires. Property capabilities have no methods; conformance tests check them. */
export interface CapabilityMethods {
  pause: Pause;
  snapshot: Snapshot;
  ttl: Ttl;
  ports: Ports;
  ssh: Ssh;
  desktop: Desktop;
  background: Background;
  /** Files survive pause and resume. Requires `pause`. */
  persistentDisk: object;
}

export type Capability = keyof CapabilityMethods;

export const CAPABILITIES = ["pause", "snapshot", "ttl", "ports", "ssh", "desktop", "background", "persistentDisk"] as const satisfies readonly Capability[];

/** Methods each capability must expose at runtime (for JavaScript callers and dynamically loaded providers). */
export const CAPABILITY_METHODS: { [C in Capability]: readonly string[] } = {
  pause: ["pause", "resume"],
  snapshot: ["snapshot", "listSnapshots", "deleteSnapshot"],
  ttl: ["setTtl"],
  ports: ["portUrl"],
  ssh: ["ssh"],
  desktop: ["desktop"],
  background: ["startBackground"],
  persistentDisk: [],
};

/** Capabilities that only make sense with another one. */
export const CAPABILITY_REQUIRES: Partial<Record<Capability, readonly Capability[]>> = {
  persistentDisk: ["pause"],
};

export const CORE_METHODS = ["create", "get", "list", "destroy", "exec", "readFile", "writeFile"] as const;

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/** A provider implementing the core and the capabilities in `C`. */
export type Provider<C extends Capability = never> = Core & {
  readonly name: string;
  readonly capabilities: readonly C[];
} & ([C] extends [never] ? unknown : UnionToIntersection<CapabilityMethods[C]>);

/** Any provider, whatever its capabilities. */
export type AnyProvider = Core & { readonly name: string; readonly capabilities: readonly Capability[] };

/** The capabilities a provider type declares. */
export type CapabilitiesOf<P> = P extends { readonly capabilities: readonly (infer C)[] } ? C : never;
