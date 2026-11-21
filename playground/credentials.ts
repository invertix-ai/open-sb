// Keys entered in the playground UI. They live in ~/.config/open-sb/credentials.json (outside any repository),
// written atomically with file mode 0600 in a 0700 directory, and win over environment variables of the same
// name. Nothing here returns a value to the browser: callers get each variable's status (saved, from the
// environment, or not set) and the server-side merged environment.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PROVIDERS, byModule } from "./providers.ts";

type Env = Record<string, string | undefined>;

/** The model credentials (Claude and OpenAI) are stored like providers under these names. */
export const CLAUDE = "claude";
export const CLAUDE_VARIABLES = ["ANTHROPIC_API_KEY"];
export const OPENAI = "openai";
export const OPENAI_VARIABLES = ["OPENAI_API_KEY"];
/** A model API's credential, as opposed to a sandbox provider's. */
export const isModelKey = (module: string) => module === CLAUDE || module === OPENAI;

/** Longest value accepted for one variable. */
export const MAX_VALUE_LENGTH = 4096;

interface StoreFile {
  version: 1;
  values: Record<string, Record<string, string>>;
}

/** Read lazily so tests (and a changed HOME) pick the right place. */
export const credentialsDir = () => join(homedir(), ".config", "open-sb");
export const credentialsPath = () => join(credentialsDir(), "credentials.json");

export function loadSaved(): Record<string, Record<string, string>> {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Partial<StoreFile>;
    if (typeof parsed.values !== "object" || parsed.values === null) return {};
    const result: Record<string, Record<string, string>> = {};
    for (const [module, values] of Object.entries(parsed.values)) {
      if (typeof values !== "object" || values === null) continue;
      const known = new Set(variablesOf(module));
      result[module] = Object.fromEntries(Object.entries(values).filter(([name, value]) => known.has(name) && typeof value === "string" && value !== ""));
    }
    return result;
  } catch {
    return {};
  }
}

function writeSaved(values: Record<string, Record<string, string>>): void {
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const clean = Object.fromEntries(Object.entries(values).filter(([, entry]) => Object.keys(entry).length > 0));
  const temporary = join(dir, `.credentials.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temporary, JSON.stringify({ version: 1, values: clean } satisfies StoreFile, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, credentialsPath());
}

/** Every variable a provider (or a model API) reads, required first. */
export function variablesOf(module: string): string[] {
  if (module === CLAUDE) return CLAUDE_VARIABLES;
  if (module === OPENAI) return OPENAI_VARIABLES;
  const entry = byModule.get(module);
  if (!entry) return [];
  return [...new Set([...entry.required, ...(entry.alternatives?.flat() ?? []), ...entry.optional])];
}

export const isSecretName = (name: string) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name);

export class CredentialError extends Error {}

/** Checks names and values from the browser; empty strings mean "leave as is" and are dropped. */
export function validateValues(module: string, input: unknown): Record<string, string> {
  if (!isModelKey(module) && !byModule.has(module)) throw new CredentialError(`Unknown provider ${module}`);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new CredentialError("values must be an object of variable names to strings");
  const known = new Set(variablesOf(module));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!known.has(name)) throw new CredentialError(`${name} is not a variable of ${module}`);
    if (typeof value !== "string") throw new CredentialError(`${name} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > MAX_VALUE_LENGTH) throw new CredentialError(`${name} is longer than ${MAX_VALUE_LENGTH} characters`);
    // Control characters and spaces never belong in a key or id; rejecting them also keeps headers safe.
    if (/[\x00-\x20\x7f]/.test(trimmed)) throw new CredentialError(`${name} contains spaces or control characters`);
    if (trimmed !== "") values[name] = trimmed;
  }
  return values;
}

/** Merges new values into the saved ones for a module (existing saved values not mentioned are kept). */
export function saveValues(module: string, values: Record<string, string>): void {
  const saved = loadSaved();
  saved[module] = { ...saved[module], ...values };
  writeSaved(saved);
}

export function removeValues(module: string): void {
  const saved = loadSaved();
  if (!(module in saved)) return;
  delete saved[module];
  writeSaved(saved);
}

/** The environment the server uses: process variables, with saved values on top. */
export function mergedEnv(base: Env, saved = loadSaved()): Env {
  const env: Env = { ...base };
  for (const values of Object.values(saved)) Object.assign(env, values);
  return env;
}

export type FieldStatus = "saved" | "env" | "unset";

export interface FieldInfo {
  name: string;
  secret: boolean;
  required: boolean;
  status: FieldStatus;
}

export interface CredentialStatus {
  module: string;
  title: string;
  keyUrl: string | null;
  fields: FieldInfo[];
  /** Other ways to authenticate, as sets of variable names (Vercel: an OIDC token instead). */
  alternatives: string[][];
}

/** Where each provider hands out keys. Only pages checked to exist; others have none. */
export const KEY_URLS: Record<string, string> = {
  e2b: "https://e2b.dev/dashboard?tab=keys",
  daytona: "https://app.daytona.io/dashboard/keys",
  vercel: "https://vercel.com/account/tokens",
  modal: "https://modal.com/settings/tokens",
  fly: "https://fly.io/user/personal_access_tokens",
  morph: "https://cloud.morph.so/web/keys",
  blaxel: "https://app.blaxel.ai",
  upstash: "https://console.upstash.com",
  freestyle: "https://dash.freestyle.sh",
  hopx: "https://console.hopx.ai",
  beam: "https://platform.beam.cloud/settings/api-keys",
  boat: "https://boat.dev/dashboard",
  agent37: "https://www.agent37.com",
  [CLAUDE]: "https://platform.claude.com/settings/keys",
  [OPENAI]: "https://platform.openai.com/api-keys",
};

/** Status of every variable for every provider and model API. Never includes a value. */
export function credentialStatuses(base: Env): CredentialStatus[] {
  const saved = loadSaved();
  const status = (module: string, name: string): FieldStatus =>
    saved[module]?.[name] ? "saved" : base[name] ? "env" : "unset";
  const describe = (module: string, title: string, required: string[], alternatives: string[][]): CredentialStatus => ({
    module, title, keyUrl: KEY_URLS[module] ?? null, alternatives,
    fields: variablesOf(module).map(name => ({ name, secret: isSecretName(name), required: required.includes(name), status: status(module, name) })),
  });
  return [
    ...PROVIDERS.map(entry => describe(entry.module, entry.title, entry.required, entry.alternatives ?? [])),
    describe(CLAUDE, "Claude API key", CLAUDE_VARIABLES, []),
    describe(OPENAI, "OpenAI API key", OPENAI_VARIABLES, []),
  ];
}

/** Saved values of length 8 or more, for redaction. */
export const savedSecretValues = () => Object.values(loadSaved()).flatMap(values => Object.values(values)).filter(value => value.length >= 8);
