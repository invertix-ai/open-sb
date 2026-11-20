// Fallback across the config's providers, in order. Only outages (`unavailable`) move on to the next
// provider; refusals, missing sandboxes and timeouts are the caller's to handle, since another provider
// would not fix them.
import type { Config } from "./config.ts";
import { isUnavailable, SandboxError } from "./errors.ts";
import type { AnyProvider } from "./types.ts";

export interface FailoverOptions {
  /** Called when a provider is skipped because it is unavailable. */
  onFallback?(event: { from: string; to: string; error: SandboxError }): void;
}

/** Runs `work` on the first provider that is not down. Throws the last outage when every provider is down. */
export async function failover<P extends AnyProvider, T>(config: Config<never, readonly P[]> | { providers: readonly P[] },
  work: (provider: P) => Promise<T>, options: FailoverOptions = {}): Promise<{ provider: P; result: T }> {
  const providers = config.providers;
  if (providers.length === 0) throw new Error("No sandbox providers configured");
  let last: unknown;
  for (const [index, provider] of providers.entries()) {
    try {
      return { provider, result: await work(provider) };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      last = error;
      const next = providers[index + 1];
      if (next) options.onFallback?.({ from: provider.name, to: next.name, error: error as SandboxError });
    }
  }
  throw last;
}

/** The provider by name, typed with the config's providers. */
export function providerNamed<P extends AnyProvider>(config: { providers: readonly P[] }, name: string): P {
  const provider = config.providers.find(candidate => candidate.name === name);
  if (!provider) throw new Error(`Provider ${name} is not in the sandbox config`);
  return provider;
}
