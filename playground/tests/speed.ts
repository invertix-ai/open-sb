// Speed: how long the basic operations take on each provider. Create until `running`, first exec, a series of
// `true` round trips, a 1 MiB write and read, pause and resume when the provider can, and destroy.
import { randomBytes } from "node:crypto";
import { createSandbox, destroySandbox, elapsed, has, intOption, method, waitForState, type TestContext } from "../harness.ts";
import { mbPerSecond, summarize } from "../stats.ts";

export interface SpeedOptions {
  /** Exec round trips after the first. Default 10. */
  rounds: number;
  /** File size for the write and read, in MiB. Default 1. */
  fileMiB: number;
  /** Measure pause and resume when the provider has them. Default true. */
  pause: boolean;
}

export function speedOptions(raw: Record<string, unknown>): SpeedOptions {
  return { rounds: intOption(raw.rounds, 10, 1, 50), fileMiB: intOption(raw.fileMiB, 1, 1, 16), pause: raw.pause !== false };
}

export async function speed(ctx: TestContext) {
  const options = speedOptions(ctx.options);
  const metrics: Record<string, number> = {};
  const metric = (name: string, value: number, unit: string, extra: Record<string, unknown> = {}) => {
    metrics[name] = value;
    ctx.emit({ type: "metric", name, value, unit, ...extra });
  };
  const log = (message: string) => ctx.emit({ type: "log", level: "info", message });

  let start = performance.now();
  log("Creating sandbox");
  const id = await createSandbox(ctx);
  metric("create_call_ms", elapsed(start), "ms");
  await waitForState(ctx, id, "running");
  metric("create_ms", elapsed(start), "ms");
  log(`Sandbox ${id} is running`);

  start = performance.now();
  const first = await ctx.provider.exec(id, "true", { signal: ctx.signal });
  metric("first_exec_ms", elapsed(start), "ms");
  if (first.exitCode !== 0) throw new Error(`\`true\` exited with ${first.exitCode}`);

  const rounds: number[] = [];
  for (let i = 0; i < options.rounds; i++) {
    start = performance.now();
    await ctx.provider.exec(id, "true", { signal: ctx.signal });
    rounds.push(elapsed(start));
  }
  const loop = summarize(rounds);
  metric("exec_p50_ms", round(loop.p50), "ms", { samples: rounds });
  metric("exec_p95_ms", round(loop.p95), "ms");

  const bytes = new Uint8Array(randomBytes(options.fileMiB * 1024 * 1024));
  start = performance.now();
  await ctx.provider.writeFile(id, "/tmp/open-sb-playground/speed.bin", bytes, { signal: ctx.signal });
  const writeMs = elapsed(start);
  metric("write_mbps", round(mbPerSecond(bytes.length, writeMs)), "MB/s", { ms: writeMs });
  start = performance.now();
  const back = await ctx.provider.readFile(id, "/tmp/open-sb-playground/speed.bin", { signal: ctx.signal });
  const readMs = elapsed(start);
  metric("read_mbps", round(mbPerSecond(back.length, readMs)), "MB/s", { ms: readMs });
  if (back.length !== bytes.length || !Buffer.from(back).equals(Buffer.from(bytes)))
    throw new Error(`readFile returned ${back.length} bytes that differ from the ${bytes.length} written`);

  if (options.pause && has(ctx.provider, "pause")) {
    start = performance.now();
    await method<(id: string, o: object) => Promise<void>>(ctx.provider, "pause")(id, { signal: ctx.signal });
    await waitForState(ctx, id, "stopped");
    metric("pause_ms", elapsed(start), "ms");
    start = performance.now();
    await method<(id: string, o: object) => Promise<void>>(ctx.provider, "resume")(id, { signal: ctx.signal });
    await waitForState(ctx, id, "running");
    // Running is not always ready: count the resume as done when a command works again.
    for (let tries = 0; ; tries++) {
      const result = await ctx.provider.exec(id, "true", { signal: ctx.signal }).catch(() => null);
      if (result?.exitCode === 0) break;
      if (tries > 120) throw new Error("exec still fails a minute after resume");
      await new Promise(done => setTimeout(done, 500));
    }
    metric("resume_ms", elapsed(start), "ms");
  } else if (options.pause) {
    log("No pause capability: pause and resume skipped");
  }

  start = performance.now();
  await destroySandbox(ctx, id);
  metric("destroy_ms", elapsed(start), "ms");
  return { metrics };
}

const round = (value: number) => Math.round(value * 10) / 10;
