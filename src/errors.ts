// Provider-neutral errors. Providers map their own failures onto these so callers (and fallback) can decide
// without knowing which provider answered. Messages stay bounded: no provider bodies, URLs or credentials.

export type SandboxErrorKind =
  /** The provider is down, overloaded or unreachable; another provider may work. */
  | "unavailable"
  /** The sandbox (or snapshot) does not exist. */
  | "not_found"
  /** The provider refused the request (bad input, permission, quota). Retrying elsewhere will not help. */
  | "rejected"
  /** The command or call ran out of time. */
  | "timeout";

export class SandboxError extends Error {
  readonly kind: SandboxErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  /** Seconds the provider asked callers to wait, when it said. */
  readonly retryAfter?: number;
  constructor(kind: SandboxErrorKind, provider: string, details: { status?: number; code?: string; retryAfter?: number; message?: string } = {}) {
    super(details.message ?? `${provider}: ${kind}${details.status ? ` (${details.status}${details.code ? ` ${details.code}` : ""})` : ""}`);
    this.name = "SandboxError";
    this.kind = kind;
    this.provider = provider;
    this.status = details.status;
    this.code = details.code && /^[A-Za-z0-9_.-]{1,64}$/.test(details.code) ? details.code : undefined;
    this.retryAfter = details.retryAfter;
  }
}

/** The usual HTTP mapping: 5xx and 429 are outages, 404 is not found, other 4xx are refusals. */
export function httpError(provider: string, status: number | null, code?: string, retryAfter?: number): SandboxError {
  if (status === null || status >= 500 || status === 429) return new SandboxError("unavailable", provider, { status: status ?? undefined, code, retryAfter });
  if (status === 404) return new SandboxError("not_found", provider, { status, code });
  if (status === 408) return new SandboxError("timeout", provider, { status, code });
  return new SandboxError("rejected", provider, { status, code });
}

export const isUnavailable = (error: unknown): boolean => error instanceof SandboxError && error.kind === "unavailable";
