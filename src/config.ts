// The config file: which capabilities the application needs, and the providers to use in fallback order.
// Compatibility is checked three times: by the type checker (`defineConfig`), at startup (`assertCompatible`)
// and in CI against real sandboxes (`sandbox-kit/conformance`).
import {
  CAPABILITIES, CAPABILITY_METHODS, CAPABILITY_REQUIRES, CORE_METHODS,
  type AnyProvider, type CapabilitiesOf, type Capability, type Provider,
} from "./types.ts";

/** Shown by the type checker in place of a provider that lacks a required capability. */
export interface MissingCapabilities<Name, Missing extends Capability> {
  readonly __error: "Provider lacks required capabilities";
  readonly provider: Name;
  readonly missing: Missing;
}

type Checked<P, R extends Capability> =
  [Exclude<R, CapabilitiesOf<P>>] extends [never] ? P
    : MissingCapabilities<P extends { readonly name: infer N } ? N : string, Exclude<R, CapabilitiesOf<P>>>;

export interface Config<R extends Capability = Capability, P extends readonly AnyProvider[] = readonly AnyProvider[]> {
  /** Every provider must implement all of these. */
  requires: readonly R[];
  /** Tried in this order: the first is primary, the rest are fallbacks. */
  providers: P;
}

/** Defines a config; a provider without a required capability is a type error. */
export function defineConfig<const R extends Capability, const P extends readonly AnyProvider[]>(config: {
  requires: readonly R[];
  providers: { [K in keyof P]: Checked<P[K], R> } & P;
}): Config<R, P> {
  return config as Config<R, P>;
}

/** Defines a provider; declaring a capability without its methods is a type error. */
export function defineProvider<const C extends Capability>(provider: Provider<C>): Provider<C> {
  return provider;
}

export interface ProviderReport {
  provider: string;
  /** Required capabilities the provider does not declare or does not implement. */
  missing: Capability[];
  /** Declared capabilities whose methods are absent, or whose prerequisites are not declared. */
  broken: string[];
}

/** Checks one provider at runtime: declared capabilities, their methods, and the core. */
export function checkProvider(provider: AnyProvider, requires: readonly Capability[]): ProviderReport {
  const declared = new Set<string>(provider.capabilities);
  const record = provider as unknown as Record<string, unknown>;
  const broken: string[] = [];
  for (const method of CORE_METHODS)
    if (typeof record[method] !== "function") broken.push(`core method ${method}()`);
  for (const capability of provider.capabilities) {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) { broken.push(`unknown capability ${capability}`); continue; }
    for (const method of CAPABILITY_METHODS[capability])
      if (typeof record[method] !== "function") broken.push(`${capability}: method ${method}()`);
    for (const needed of CAPABILITY_REQUIRES[capability] ?? [])
      if (!declared.has(needed)) broken.push(`${capability}: requires ${needed}`);
  }
  const missing = requires.filter(capability => !declared.has(capability) ||
    CAPABILITY_METHODS[capability].some(method => typeof record[method] !== "function"));
  return { provider: provider.name, missing, broken };
}

export function checkConfig(config: Config): ProviderReport[] {
  return config.providers.map(provider => checkProvider(provider, config.requires));
}

export class IncompatibleProviderError extends Error {
  readonly reports: ProviderReport[];
  constructor(reports: ProviderReport[]) {
    super("Incompatible sandbox providers:\n" + reports.map(report => `  ${report.provider}: ` +
      [...report.missing.map(capability => `missing ${capability}`), ...report.broken].join(", ")).join("\n"));
    this.name = "IncompatibleProviderError";
    this.reports = reports;
  }
}

/** Throws unless every provider implements every required capability. Call it at startup. */
export function assertCompatible<C extends Config>(config: C): C {
  if (config.providers.length === 0) throw new Error("A sandbox config needs at least one provider");
  const failed = checkConfig(config).filter(report => report.missing.length > 0 || report.broken.length > 0);
  if (failed.length > 0) throw new IncompatibleProviderError(failed);
  return config;
}
