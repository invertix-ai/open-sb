// The 17 providers the playground can drive: display name, module, logo, the environment variables each one
// needs (the same names as test/<module>.conformance.ts) and a factory that builds it from them. A provider is
// available when its required variables are set; Docker when `docker info` succeeds. Nothing here ever
// returns a variable's value, only its name.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { AnyProvider, Capability } from "../src/types.ts";
import { agent37 } from "../src/providers/agent37.ts";
import { beam } from "../src/providers/beam.ts";
import { blaxel } from "../src/providers/blaxel.ts";
import { boat } from "../src/providers/boat.ts";
import { codesandbox } from "../src/providers/codesandbox.ts";
import { daytona } from "../src/providers/daytona.ts";
import { docker } from "../src/providers/docker.ts";
import { e2b } from "../src/providers/e2b.ts";
import { fly } from "../src/providers/fly.ts";
import { freestyle } from "../src/providers/freestyle.ts";
import { hopx } from "../src/providers/hopx.ts";
import { modal } from "../src/providers/modal.ts";
import { morph } from "../src/providers/morph.ts";
import { runloop } from "../src/providers/runloop.ts";
import { sprites } from "../src/providers/sprites.ts";
import { upstash } from "../src/providers/upstash.ts";
import { vercel } from "../src/providers/vercel.ts";

type Env = Record<string, string | undefined>;

export interface ProviderEntry {
  module: string;
  title: string;
  kind: string;
  /** All of these must be set. */
  required: string[];
  /** Alternatives: the provider is also available when every variable of one of these sets is present. */
  alternatives?: string[][];
  /** Read when present, never required. */
  optional: string[];
  /** Builds the provider. Constructing one makes no network calls. */
  build(env: Env): AnyProvider;
}

const PLACEHOLDER = "unused";
const opt = (value: string | undefined) => value || undefined;

/** The port the stream test's HTTP server listens on; Vercel needs it declared when the sandbox is created. */
export const STREAM_PORT = 8080;

export const PROVIDERS: ProviderEntry[] = [
  { module: "e2b", title: "E2B", kind: "Firecracker microVMs", required: ["E2B_API_KEY"], optional: ["E2B_TEMPLATE"],
    build: env => e2b({ apiKey: env.E2B_API_KEY, template: opt(env.E2B_TEMPLATE) }) },
  { module: "daytona", title: "Daytona", kind: "Fast dev sandboxes", required: ["DAYTONA_API_KEY"], optional: ["DAYTONA_API_URL", "DAYTONA_TARGET"],
    build: env => daytona({ apiKey: env.DAYTONA_API_KEY, apiUrl: opt(env.DAYTONA_API_URL), target: opt(env.DAYTONA_TARGET) }) },
  { module: "vercel", title: "Vercel Sandbox", kind: "Ephemeral microVMs", required: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
    alternatives: [["VERCEL_OIDC_TOKEN"]], optional: [],
    build: env => vercel({ token: opt(env.VERCEL_TOKEN), teamId: opt(env.VERCEL_TEAM_ID), projectId: opt(env.VERCEL_PROJECT_ID), ports: [STREAM_PORT] }) },
  { module: "modal", title: "Modal", kind: "Serverless containers", required: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"], optional: [],
    build: env => modal({ tokenId: env.MODAL_TOKEN_ID, tokenSecret: env.MODAL_TOKEN_SECRET }) },
  { module: "sprites", title: "Fly Sprites", kind: "Persistent agent computers", required: ["SPRITES_TOKEN"], optional: ["SPRITES_API_URL"],
    build: env => sprites({ token: env.SPRITES_TOKEN ?? "", baseURL: opt(env.SPRITES_API_URL) }) },
  { module: "fly", title: "Fly Machines", kind: "Fast-launching VMs", required: ["FLY_API_TOKEN", "FLY_APP"], optional: ["FLY_REGION"],
    build: env => fly({ apiToken: env.FLY_API_TOKEN ?? "", app: env.FLY_APP ?? "", region: opt(env.FLY_REGION) }) },
  { module: "runloop", title: "Runloop", kind: "Devboxes for coding agents", required: ["RUNLOOP_API_KEY"], optional: ["RUNLOOP_BASE_URL", "RUNLOOP_BLUEPRINT"],
    build: env => runloop({ apiKey: env.RUNLOOP_API_KEY, baseUrl: opt(env.RUNLOOP_BASE_URL), blueprint: opt(env.RUNLOOP_BLUEPRINT) }) },
  { module: "codesandbox", title: "CodeSandbox", kind: "MicroVMs that hibernate", required: ["CSB_API_KEY"], optional: ["CSB_TEMPLATE"],
    build: env => codesandbox({ apiKey: env.CSB_API_KEY, template: opt(env.CSB_TEMPLATE) }) },
  { module: "morph", title: "Morph Cloud", kind: "VMs with instant snapshots", required: ["MORPH_API_KEY"], optional: ["MORPH_SNAPSHOT"],
    build: env => morph({ apiKey: env.MORPH_API_KEY, snapshot: opt(env.MORPH_SNAPSHOT) }) },
  { module: "blaxel", title: "Blaxel", kind: "Perpetual agent sandboxes", required: ["BL_API_KEY", "BL_WORKSPACE"], optional: ["BL_REGION", "BLAXEL_IMAGE"],
    build: env => blaxel({ apiKey: env.BL_API_KEY, workspace: env.BL_WORKSPACE, region: opt(env.BL_REGION), image: opt(env.BLAXEL_IMAGE) }) },
  { module: "upstash", title: "Upstash Box", kind: "Boxes for coding agents", required: ["UPSTASH_BOX_API_KEY"], optional: [],
    build: env => upstash({ apiKey: env.UPSTASH_BOX_API_KEY, runtime: "python" }) },
  { module: "freestyle", title: "Freestyle", kind: "VMs that fork and pause", required: ["FREESTYLE_API_KEY"], optional: ["FREESTYLE_IMAGE"],
    build: env => freestyle({ apiKey: env.FREESTYLE_API_KEY, image: opt(env.FREESTYLE_IMAGE) }) },
  { module: "hopx", title: "HOPX", kind: "Firecracker sandboxes", required: ["HOPX_API_KEY"], optional: ["HOPX_TEMPLATE"],
    build: env => hopx({ apiKey: env.HOPX_API_KEY, template: opt(env.HOPX_TEMPLATE) }) },
  { module: "beam", title: "Beam", kind: "Agent workspaces", required: ["BEAM_TOKEN"], optional: ["BEAM_WORKSPACE_ID"],
    build: env => beam({ token: env.BEAM_TOKEN, workspaceId: opt(env.BEAM_WORKSPACE_ID), cpu: 1, memory: "2Gi" }) },
  { module: "boat", title: "Boat", kind: "Full cloud VMs", required: ["BOAT_API_KEY"], optional: [],
    build: env => boat({ apiKey: env.BOAT_API_KEY }) },
  { module: "agent37", title: "Agent37", kind: "VMs that sleep when idle", required: ["AGENT37_API_KEY"], optional: [],
    build: env => agent37({ apiKey: env.AGENT37_API_KEY ?? "" }) },
  { module: "docker", title: "Docker", kind: "Containers on your machine", required: [], optional: [],
    build: () => docker() },
];

export const byModule = new Map(PROVIDERS.map(entry => [entry.module, entry]));

const isSet = (env: Env, name: string) => typeof env[name] === "string" && env[name] !== "";

/** Required variables that are not set, or `[]` when the provider can be built. */
export function missingEnv(entry: ProviderEntry, env: Env): string[] {
  const missing = entry.required.filter(name => !isSet(env, name));
  if (missing.length === 0) return [];
  if (entry.alternatives?.some(set => set.every(name => isSet(env, name)))) return [];
  return missing;
}

/** Declared capabilities, read from a provider built with placeholder credentials (no network calls). */
const declared = new Map<string, readonly Capability[]>();
export function capabilitiesOf(entry: ProviderEntry): readonly Capability[] {
  let capabilities = declared.get(entry.module);
  if (!capabilities) {
    const env = Object.fromEntries([...entry.required, ...(entry.alternatives?.flat() ?? [])].map(name => [name, PLACEHOLDER]));
    capabilities = entry.build(env).capabilities;
    declared.set(entry.module, capabilities);
  }
  return capabilities;
}

let dockerCheck: { at: number; ok: Promise<boolean> } | undefined;
/** Whether the Docker daemon answers, cached for 15 seconds. */
export function dockerAvailable(): Promise<boolean> {
  if (!dockerCheck || Date.now() - dockerCheck.at > 15_000)
    dockerCheck = { at: Date.now(), ok: new Promise(done => execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5_000 }, error => done(!error))) };
  return dockerCheck.ok;
}

export interface ProviderStatus {
  module: string;
  title: string;
  kind: string;
  logo: string | null;
  capabilities: readonly Capability[];
  available: boolean;
  /** Names of required variables that are not set (never values). */
  missing: string[];
  /** How to make the provider available, for the sidebar tooltip. */
  howToEnable: string;
}

const LOGO_DIR = new URL("../assets/logos/", import.meta.url);

/** The logo file for a module, if the assets folder has one (SVG preferred). */
export function logoFile(module: string): URL | null {
  for (const extension of ["svg", "png"]) {
    const file = new URL(`${module}.${extension}`, LOGO_DIR);
    if (existsSync(file)) return file;
  }
  return null;
}

function howToEnable(entry: ProviderEntry): string {
  if (entry.module === "docker") return "Start Docker on this machine (the playground runs `docker info` to check).";
  const sets = [entry.required, ...(entry.alternatives ?? [])].map(set => set.map(name => `${name}=...`).join(" "));
  const optional = entry.optional.length ? ` Optional: ${entry.optional.join(", ")}.` : "";
  return `Set ${sets.join(", or ")} in the environment, then restart pnpm run playground.${optional}`;
}

export async function providerStatuses(env: Env): Promise<ProviderStatus[]> {
  const dockerOk = await dockerAvailable();
  return PROVIDERS.map(entry => {
    const missing = entry.module === "docker" ? [] : missingEnv(entry, env);
    const logo = logoFile(entry.module);
    return {
      module: entry.module, title: entry.title, kind: entry.kind,
      logo: logo ? `/logos/${logo.pathname.split("/").pop()}` : null,
      capabilities: capabilitiesOf(entry),
      available: entry.module === "docker" ? dockerOk : missing.length === 0,
      missing, howToEnable: howToEnable(entry),
    };
  });
}

/** Built providers, reused while their variables stay the same (some SDKs keep connections open). A saved
 * key that changes builds a new one on the next run, without a restart. */
const built = new Map<string, { fingerprint: string; provider: AnyProvider }>();
export function getProvider(module: string, env: Env): AnyProvider {
  const entry = byModule.get(module);
  if (!entry) throw new Error(`Unknown provider ${module}`);
  const names = [...entry.required, ...(entry.alternatives?.flat() ?? []), ...entry.optional];
  const fingerprint = JSON.stringify(names.map(name => env[name] ?? null));
  const cached = built.get(module);
  if (cached?.fingerprint === fingerprint) return cached.provider;
  const provider = entry.build(env);
  built.set(module, { fingerprint, provider });
  return provider;
}

/** Every credential value the registry reads, so the server can redact them from anything it sends. */
export function secretValues(env: Env): string[] {
  const names = new Set(PROVIDERS.flatMap(entry => [...entry.required, ...(entry.alternatives?.flat() ?? []), ...entry.optional]));
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]) names.add(name);
  return [...names].map(name => env[name]).filter((value): value is string => typeof value === "string" && value.length >= 8);
}
