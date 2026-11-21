// Live stream: a background process in the sandbox appends a numbered, timestamped line to a file every
// interval; the harness polls the file with exec and streams new lines to the UI. Delivery lag is the time
// from a line's timestamp (corrected by the sandbox clock offset measured at start) to its arrival here.
// With `ports`, an HTTP server's URL is shown when it needs no credential headers; with `desktop`, the viewer.
import { STREAM_PORT } from "../providers.ts";
import { createSandbox, destroySandbox, emitDesktop, emitPortLink, errorInfo, has, intOption, method, sleep, waitForState, type TestContext } from "../harness.ts";
import { summarize } from "../stats.ts";

export interface StreamOptions {
  durationS: number;
  intervalMs: number;
  pollMs: number;
}

export function streamOptions(raw: Record<string, unknown>): StreamOptions {
  return { durationS: intOption(raw.durationS, 15, 5, 120), intervalMs: intOption(raw.intervalMs, 200, 50, 2_000), pollMs: intOption(raw.pollMs, 400, 100, 5_000) };
}

const DIR = "/tmp/open-sb-playground";

/** Sandbox clock minus local clock, in ms, from the probe with the shortest round trip. */
async function clockOffset(ctx: TestContext, id: string): Promise<{ offsetMs: number; precise: boolean; rttMs: number }> {
  const probes = ["date +%s%3N", "python3 -c 'import time; print(int(time.time() * 1000))'"];
  for (const probe of probes) {
    let best: { offsetMs: number; rttMs: number } | undefined;
    for (let i = 0; i < 3; i++) {
      const before = Date.now();
      const result = await ctx.provider.exec(id, probe, { signal: ctx.signal });
      const after = Date.now();
      const value = Number(result.stdout.trim());
      if (result.exitCode !== 0 || !/^\d{13}$/.test(result.stdout.trim())) break;
      const sample = { offsetMs: value - (before + after) / 2, rttMs: after - before };
      if (!best || sample.rttMs < best.rttMs) best = sample;
    }
    if (best) return { ...best, precise: probe === probes[0] };
  }
  // Second precision only: lags are then accurate to about a second.
  const before = Date.now();
  const result = await ctx.provider.exec(id, "date +%s", { signal: ctx.signal });
  const after = Date.now();
  return { offsetMs: Number(result.stdout.trim()) * 1000 + 500 - (before + after) / 2, rttMs: after - before, precise: false };
}

export async function stream(ctx: TestContext) {
  const options = streamOptions(ctx.options);
  const log = (message: string, level = "info") => ctx.emit({ type: "log", level, message });
  if (!has(ctx.provider, "background")) {
    log(`${ctx.title} has no background capability, so it cannot run a process that outlives one exec. Skipped.`, "warn");
    return { skipped: "no background capability" };
  }
  const startBackground = method<(id: string, command: string, o?: object) => Promise<void>>(ctx.provider, "startBackground");

  log("Creating sandbox");
  const id = await createSandbox(ctx);
  await waitForState(ctx, id, "running");
  const clock = await clockOffset(ctx, id);
  ctx.emit({ type: "metric", name: "clock", offsetMs: Math.round(clock.offsetMs), rttMs: clock.rttMs, precise: clock.precise });
  log(`Sandbox clock offset ${Math.round(clock.offsetMs)} ms (probe round trip ${clock.rttMs} ms${clock.precise ? "" : ", second precision"})`);

  const total = Math.round((options.durationS * 1000) / options.intervalMs);
  const stamp = clock.precise ? "$(date +%s%3N)" : "$(date +%s)000";
  const script = `i=0; while [ $i -lt ${total} ]; do i=$((i+1)); echo "$i ${stamp} line $i of ${total}"; sleep ${options.intervalMs / 1000}; done >> ${DIR}/stream.log`;
  await ctx.provider.writeFile(id, `${DIR}/stream.sh`, script, { signal: ctx.signal });
  await ctx.provider.exec(id, `: > ${DIR}/stream.log`, { signal: ctx.signal });
  await startBackground(id, `sh ${DIR}/stream.sh`);
  log(`Background writer started: ${total} lines, one every ${options.intervalMs} ms`);

  const extras = side(ctx, id, startBackground);

  const lags: number[] = [];
  let offset = 0, lastLine = 0, missing = 0;
  const deadline = Date.now() + options.durationS * 1000 + 20_000;
  while (lastLine < total && Date.now() < deadline) {
    await sleep(options.pollMs, ctx.signal);
    const result = await ctx.provider.exec(id, `tail -c +${offset + 1} ${DIR}/stream.log`, { signal: ctx.signal });
    const received = Date.now();
    const end = result.stdout.lastIndexOf("\n");
    if (end < 0) continue;
    const chunk = result.stdout.slice(0, end + 1);
    offset += Buffer.byteLength(chunk);
    const lines = [];
    for (const text of chunk.split("\n").filter(Boolean)) {
      const match = /^(\d+) (\d+)/.exec(text);
      if (!match) continue;
      const n = Number(match[1]);
      const lagMs = Math.max(0, Math.round(received - (Number(match[2]) - clock.offsetMs)));
      if (n > lastLine + 1) missing += n - lastLine - 1;
      lastLine = Math.max(lastLine, n);
      lags.push(lagMs);
      lines.push({ n, text, lagMs });
    }
    if (lines.length === 0) continue;
    ctx.emit({ type: "output", kind: "lines", lines });
    const lag = summarize(lags);
    ctx.emit({ type: "metric", name: "lag", p50: lag.p50, p95: lag.p95, max: lag.max, received: lags.length, expected: total });
  }
  await extras;
  const lag = summarize(lags);
  await destroySandbox(ctx, id);
  if (lags.length < total) log(`Received ${lags.length} of ${total} lines before the deadline`, "warn");
  return { received: lags.length, expected: total, missing: missing + Math.max(0, total - lastLine), lag, clock };
}

/** The port link and desktop viewer, in parallel with the stream. Their failures are logged, not fatal. */
async function side(ctx: TestContext, id: string, startBackground: (id: string, command: string, o?: object) => Promise<void>) {
  const log = (message: string, level = "info") => ctx.emit({ type: "log", level, message });
  if (has(ctx.provider, "ports")) {
    try {
      const python = await ctx.provider.exec(id, "command -v python3", { signal: ctx.signal });
      if (python.exitCode !== 0) log("The image has no python3, so no HTTP server was started", "warn");
      else {
        await ctx.provider.writeFile(id, `${DIR}/www/index.html`, `<h1>open-sb playground</h1><p>Served from a ${ctx.title} sandbox.</p>`, { signal: ctx.signal });
        await startBackground(id, `python3 -m http.server ${STREAM_PORT} --bind 0.0.0.0`, { cwd: `${DIR}/www` });
      }
      // emitPortLink keeps a URL that needs credential headers (or user info) on the server.
      await emitPortLink(ctx, id, STREAM_PORT);
    } catch (error) {
      log(`Port URL failed: ${errorInfo(error).message}`, "warn");
    }
  }
  if (has(ctx.provider, "desktop")) {
    try {
      await emitDesktop(ctx, id);
    } catch (error) {
      log(`Desktop failed: ${errorInfo(error).message}`, "warn");
    }
  }
}
