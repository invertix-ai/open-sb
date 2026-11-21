// Load: N sandboxes at once per provider. Each one is created, waited on until running, runs `echo ok` and is
// destroyed. Reports the success rate, errors grouped by SandboxError kind, and latency distributions.
import { createSandbox, destroySandbox, elapsed, errorInfo, intOption, waitForState, type TestContext } from "../harness.ts";
import { histogram, summarize } from "../stats.ts";

export const MAX_LOAD = 20;

export function loadOptions(raw: Record<string, unknown>): { n: number } {
  return { n: intOption(raw.n, 5, 1, MAX_LOAD) };
}

export async function load(ctx: TestContext) {
  const { n } = loadOptions(ctx.options);
  ctx.emit({ type: "log", level: "info", message: `Starting ${n} sandboxes at once` });
  const ready: number[] = [], total: number[] = [], errors: Record<string, number> = {};
  const messages: Record<string, string> = {};
  let done = 0, ok = 0;

  const report = () => ctx.emit({
    type: "metric", name: "load", n, done, ok, errors,
    ready: summarize(ready), total: summarize(total),
    readyHistogram: histogram(ready, 10), totalHistogram: histogram(total, 10),
  });

  await Promise.all(Array.from({ length: n }, async (_, index) => {
    const start = performance.now();
    let id: string | undefined;
    try {
      id = await createSandbox(ctx);
      await waitForState(ctx, id, "running");
      const readyMs = elapsed(start);
      const result = await ctx.provider.exec(id, "echo ok", { signal: ctx.signal });
      if (result.exitCode !== 0 || result.stdout.trim() !== "ok") throw new Error(`echo ok returned ${result.exitCode}: ${result.stdout.trim().slice(0, 80)}`);
      await destroySandbox(ctx, id);
      id = undefined;
      ready.push(readyMs);
      total.push(elapsed(start));
      ok++;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const info = errorInfo(error);
      errors[info.kind] = (errors[info.kind] ?? 0) + 1;
      messages[info.kind] ??= info.message;
      ctx.emit({ type: "log", level: "warn", message: `Sandbox ${index + 1}: ${info.message}` });
    } finally {
      if (id) await destroySandbox(ctx, id).catch(() => undefined);
      done++;
      report();
    }
  }));
  return { n, succeeded: ok, successRate: ok / n, errors, errorExamples: messages, ready: summarize(ready), total: summarize(total) };
}
