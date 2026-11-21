// What every playground test shares: the per-provider context, labelled sandbox creation with guaranteed
// cleanup, waiting for a state, error mapping for display, and running one test across providers in parallel
// so a failure in one provider never stops the others.
import { SandboxError } from "../src/errors.ts";
import type { AnyProvider, SandboxState } from "../src/types.ts";
import type { Emit, Run } from "./runs.ts";

/** Every sandbox the playground creates carries this label, with the run ID as its value. */
export const LABEL = "open-sb.playground";

export interface TestContext {
  runId: string;
  module: string;
  title: string;
  provider: AnyProvider;
  options: Record<string, unknown>;
  signal: AbortSignal;
  /** Emits an event for this provider. */
  emit: Emit;
}

export type TestFn = (ctx: TestContext) => Promise<unknown>;

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done, fail) => {
  if (signal?.aborted) return fail(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
  const abort = () => { clearTimeout(timer); fail(signal!.reason); };
  signal?.addEventListener("abort", abort, { once: true });
});

/** How an error is shown: the SandboxError kind when there is one, and a short message. */
export function errorInfo(error: unknown): { kind: string; message: string } {
  if (error instanceof SandboxError) return { kind: error.kind, message: error.message.slice(0, 300) };
  if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) return { kind: "cancelled", message: "Cancelled" };
  if (error instanceof Error) return { kind: "error", message: `${error.name}: ${error.message}`.slice(0, 300) };
  return { kind: "error", message: String(error).slice(0, 300) };
}

/** Sandboxes alive right now: provider module, then sandbox ID to run ID. For cleanup and the header counter. */
export const live = new Map<string, Map<string, string>>();
const track = (module: string, id: string, runId: string) => {
  if (!live.has(module)) live.set(module, new Map());
  live.get(module)!.set(id, runId);
};
const untrack = (module: string, id: string) => live.get(module)?.delete(id);
export const liveCount = () => [...live.values()].reduce((sum, ids) => sum + ids.size, 0);

/** At most this many creates in flight per provider, whatever the number of runs. */
export const MAX_CREATES_PER_PROVIDER = 20;
const inFlight = new Map<string, { count: number; queue: (() => void)[] }>();
async function acquire(module: string, signal: AbortSignal): Promise<() => void> {
  const slot = inFlight.get(module) ?? { count: 0, queue: [] };
  inFlight.set(module, slot);
  while (slot.count >= MAX_CREATES_PER_PROVIDER) {
    await new Promise<void>(done => slot.queue.push(done));
    signal.throwIfAborted();
  }
  slot.count++;
  return () => { slot.count--; slot.queue.shift()?.(); };
}

/** Creates a labelled sandbox and records it so the run destroys it even if the test does not. */
export async function createSandbox(ctx: TestContext, extraLabels: Record<string, string> = {}): Promise<string> {
  const release = await acquire(ctx.module, ctx.signal);
  try {
    const info = await ctx.provider.create({ labels: { [LABEL]: ctx.runId, ...extraLabels }, signal: ctx.signal });
    track(ctx.module, info.id, ctx.runId);
    return info.id;
  } finally {
    release();
  }
}

/** Polls `get` until the sandbox reaches `state`; throws a timeout SandboxError after `timeoutMs`. */
export async function waitForState(ctx: TestContext, id: string, state: SandboxState, timeoutMs = 300_000, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await ctx.provider.get(id, { signal: ctx.signal });
    if (info?.state === state) return;
    if (!info || info.state === "gone") throw new SandboxError("not_found", ctx.provider.name, { message: `${ctx.provider.name}: sandbox went away while waiting for ${state}` });
    if (Date.now() > deadline) throw new SandboxError("timeout", ctx.provider.name, { message: `${ctx.provider.name}: not ${state} after ${Math.round(timeoutMs / 1000)} s` });
    await sleep(intervalMs, ctx.signal);
  }
}

/** Destroys a sandbox without the run's signal, so it also works after a cancel. */
export async function destroySandbox(ctx: Pick<TestContext, "module" | "provider">, id: string): Promise<void> {
  await ctx.provider.destroy(id, { signal: AbortSignal.timeout(120_000) });
  untrack(ctx.module, id);
}

/** A whole number from user input, clamped to [min, max]; `fallback` when missing or not a number. */
export function intOption(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return fallback;
  return Math.min(max, Math.max(min, Math.round(Number(value))));
}

export const elapsed = (since: number) => Math.round((performance.now() - since) * 10) / 10;

/** The capabilities a provider declares, as a set. */
export const has = (provider: AnyProvider, capability: string) => (provider.capabilities as readonly string[]).includes(capability);

/** Calls a capability method that `has` confirmed. */
export function method<T>(provider: AnyProvider, name: string): T {
  const fn = (provider as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") throw new Error(`${provider.name} has no ${name}()`);
  return (fn as (...args: unknown[]) => unknown).bind(provider) as T;
}

/**
 * Runs `test` for every provider in parallel. Each provider reports `status` events and ends with its result
 * in `run.results`; afterwards every sandbox labelled with this run is destroyed, also on cancel.
 */
export async function runAcrossProviders(run: Run, providers: { module: string; title: string; provider: AnyProvider }[], test: TestFn): Promise<void> {
  await Promise.all(providers.map(async ({ module, title, provider }) => {
    const emit: Emit = event => run.emit({ ...event, provider: module });
    const ctx: TestContext = { runId: run.id, module, title, provider, options: run.options, signal: run.signal, emit };
    emit({ type: "status", status: "running" });
    const started = performance.now();
    try {
      const result = await test(ctx);
      run.results[module] = { ok: true, ms: elapsed(started), ...(result as object) };
      emit({ type: "status", status: "done", ms: elapsed(started) });
    } catch (error) {
      const info = errorInfo(error);
      const status = run.signal.aborted ? "cancelled" : "failed";
      run.results[module] = { ok: false, ms: elapsed(started), error: info };
      emit({ type: "error", ...info });
      emit({ type: "status", status, ms: elapsed(started) });
    } finally {
      await sweep({ module, provider }, run.id, emit);
    }
  }));
}

/** Destroys every sandbox of this run that is still around: tracked ones first, then any the label finds. */
async function sweep(ctx: Pick<TestContext, "module" | "provider">, runId: string, emit: Emit): Promise<void> {
  const ids = new Set([...(live.get(ctx.module) ?? new Map<string, string>())].filter(([, run]) => run === runId).map(([id]) => id));
  try {
    for (const sandbox of await ctx.provider.list({ labels: { [LABEL]: runId }, signal: AbortSignal.timeout(60_000) }))
      if (sandbox.state !== "gone") ids.add(sandbox.id);
  } catch (error) {
    emit({ type: "log", level: "warn", message: `Could not list sandboxes for cleanup: ${errorInfo(error).message}` });
  }
  for (const id of ids) {
    try {
      await destroySandbox(ctx, id);
      emit({ type: "log", level: "info", message: `Cleaned up sandbox ${id}` });
    } catch (error) {
      emit({ type: "log", level: "warn", message: `Could not destroy ${id}: ${errorInfo(error).message}. Use Clean up.` });
    }
  }
}
