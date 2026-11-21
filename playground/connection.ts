// "Test connection" for the key setup panels: one cheap call that creates nothing. Providers run `list()`,
// Docker `docker info`, Claude `models.retrieve`. Results carry the error kind, code and HTTP status only,
// never a provider's message text, which could echo a request or a credential.
import { execFile } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { SandboxError } from "../src/errors.ts";
import { byModule, missingEnv } from "./providers.ts";

type Env = Record<string, string | undefined>;

export interface ConnectionResult {
  ok: boolean;
  /** SandboxError kind, or `missing`, `cancelled`, `error`. */
  kind?: string;
  code?: string;
  status?: number;
  /** Required variables that are not set. */
  missing?: string[];
  ms: number;
}

const TIMEOUT_MS = 20_000;

function describe(error: unknown, started: number): ConnectionResult {
  const ms = Math.round(performance.now() - started);
  if (error instanceof SandboxError) return { ok: false, kind: error.kind, code: error.code, status: error.status, ms };
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const kind = status === undefined || status >= 500 || status === 429 ? "unavailable" : status === 404 ? "not_found" : "rejected";
    return { ok: false, kind, code: error.constructor.name, status, ms };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { ok: false, kind: "timeout", code: error.name, ms };
  // A name like TypeError or FetchError says enough; the message may quote the request.
  return { ok: false, kind: "error", code: error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : undefined, ms };
}

export async function testProvider(module: string, env: Env): Promise<ConnectionResult> {
  const started = performance.now();
  if (module === "docker") {
    return new Promise(done => execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 }, error =>
      done(error ? { ok: false, kind: "unavailable", code: "docker_unreachable", ms: Math.round(performance.now() - started) } : { ok: true, ms: Math.round(performance.now() - started) })));
  }
  const entry = byModule.get(module);
  if (!entry) return { ok: false, kind: "rejected", code: "unknown_provider", ms: 0 };
  const missing = missingEnv(entry, env);
  if (missing.length) return { ok: false, kind: "missing", missing, ms: 0 };
  try {
    // A fresh provider built from exactly these values, separate from the one runs use.
    await entry.build(env).list({ signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return describe(error, started);
  }
}

export async function testClaude(env: Env): Promise<ConnectionResult> {
  const started = performance.now();
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return { ok: false, kind: "missing", missing: ["ANTHROPIC_API_KEY"], ms: 0 };
  try {
    const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 }) : new Anthropic({ maxRetries: 0 });
    await client.models.retrieve("claude-opus-5-5", {}, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return describe(error, started);
  }
}
