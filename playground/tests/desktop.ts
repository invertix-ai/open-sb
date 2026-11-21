// A bounded, interactive desktop session. The run harness owns cleanup on stop, failure and server shutdown.
import { createSandbox, desktopImage, emitDesktop, errorInfo, has, intOption, method, sleep, waitForState, type TestContext } from "../harness.ts";
import { DESKTOP_DEMO } from "../desktop-demo.ts";

export function desktopOptions(raw: Record<string, unknown>) {
  return { durationS: intOption(raw.durationS, 600, 30, 3600), demo: raw.demo !== false };
}

export async function desktop(ctx: TestContext) {
  if (!has(ctx.provider, "desktop")) throw new Error(`${ctx.title} has no desktop capability`);
  const { durationS, demo } = desktopOptions(ctx.options);
  const started = performance.now();
  ctx.emit({ type: "log", message: "Creating a desktop sandbox" });
  const id = await createSandbox(ctx, {}, desktopImage(ctx));
  await waitForState(ctx, id, "running");
  // An extra provider-side lifetime bound covers a local process crash when the provider supports it.
  if (has(ctx.provider, "ttl"))
    await method<(id: string, seconds: number, options: object) => Promise<void>>(ctx.provider, "setTtl")(id, durationS + 180, { signal: ctx.signal });
  ctx.emit({ type: "log", message: "Starting the desktop and opening a private viewer" });
  await emitDesktop(ctx, id);
  ctx.emit({ type: "metric", name: "desktop_ready_ms", value: Math.round(performance.now() - started) });

  if (demo && has(ctx.provider, "background")) {
    try {
      const browser = await ctx.provider.exec(id, "command -v chromium || command -v chromium-browser || command -v google-chrome", { signal: ctx.signal });
      if (browser.exitCode === 0 && browser.stdout.trim()) {
        await ctx.provider.writeFile(id, "/tmp/open-sb-playground/desktop.html", DESKTOP_DEMO, { signal: ctx.signal });
        await method<(id: string, command: string, options: object) => Promise<void>>(ctx.provider, "startBackground")(
          id, 'browser=$(command -v chromium || command -v chromium-browser || command -v google-chrome); DISPLAY=${DISPLAY:-:0} "$browser" --no-sandbox --disable-dev-shm-usage --no-first-run --user-data-dir=/tmp/open-sb-desktop-browser --start-maximized --app=file:///tmp/open-sb-playground/desktop.html',
          { signal: ctx.signal },
        );
        ctx.emit({ type: "log", message: "Opened the live clock and input demo inside the sandbox" });
      } else ctx.emit({ type: "log", level: "warn", message: "No Chromium browser in this image; showing the desktop without the demo" });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.emit({ type: "log", level: "warn", message: `Could not open the demo: ${errorInfo(error).message}` });
    }
  }

  const deadline = Date.now() + durationS * 1000;
  ctx.emit({ type: "metric", name: "desktop_ends_at", value: deadline });
  ctx.emit({ type: "log", message: `Desktop ready for ${durationS / 60} minutes. Stop the session to destroy its sandbox.` });
  while (Date.now() < deadline) {
    await sleep(Math.min(30_000, deadline - Date.now()), ctx.signal);
    if (Date.now() >= deadline) break;
    // Work inside the sandbox keeps Daytona's inactivity timer alive while a person watches the screen.
    const probe = await ctx.provider.exec(id, "true", { signal: ctx.signal, timeoutMs: 15_000 });
    if (probe.exitCode !== 0) throw new Error("Desktop sandbox stopped responding");
  }
  return { durationS };
}
