// Quick verify: the core checks against one real sandbox (create, exec, write and read, list by label,
// destroy), each reported green or red. Later checks still run when an earlier one fails, where they can.
import { randomUUID } from "node:crypto";
import { LABEL, createSandbox, destroySandbox, elapsed, errorInfo, sleep, waitForState, type TestContext } from "../harness.ts";

export const CHECKS = ["create", "exec", "files", "list", "destroy"] as const;

export async function capabilities(ctx: TestContext) {
  const checks: Record<string, { ok: boolean; ms: number; message?: string }> = {};
  const check = async (name: (typeof CHECKS)[number], body: () => Promise<void>) => {
    const start = performance.now();
    try {
      await body();
      checks[name] = { ok: true, ms: elapsed(start) };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      checks[name] = { ok: false, ms: elapsed(start), message: errorInfo(error).message };
    }
    ctx.emit({ type: "metric", name: "check", check: name, ...checks[name] });
    return checks[name].ok;
  };

  let id = "";
  const marker = randomUUID().slice(0, 8);
  if (!(await check("create", async () => { id = await createSandbox(ctx); await waitForState(ctx, id, "running"); }))) {
    for (const name of CHECKS.slice(1)) {
      checks[name] = { ok: false, ms: 0, message: "Skipped: no sandbox" };
      ctx.emit({ type: "metric", name: "check", check: name, ...checks[name] });
    }
    return { checks };
  }
  await check("exec", async () => {
    const result = await ctx.provider.exec(id, "echo hello; exit 3", { signal: ctx.signal });
    if (result.stdout.trim() !== "hello" || result.exitCode !== 3) throw new Error(`expected "hello" and exit 3, got ${JSON.stringify(result.stdout.trim())} and ${result.exitCode}`);
  });
  await check("files", async () => {
    await ctx.provider.writeFile(id, "/tmp/open-sb-playground/verify.txt", `verify ${marker}\n`, { signal: ctx.signal });
    const text = Buffer.from(await ctx.provider.readFile(id, "/tmp/open-sb-playground/verify.txt", { signal: ctx.signal })).toString();
    if (text !== `verify ${marker}\n`) throw new Error("readFile returned different content");
  });
  await check("list", async () => {
    const listed = await ctx.provider.list({ labels: { [LABEL]: ctx.runId }, signal: ctx.signal });
    if (!listed.some(sandbox => sandbox.id === id)) throw new Error("list({ labels }) did not include the sandbox");
  });
  await check("destroy", async () => {
    await destroySandbox(ctx, id);
    // Some providers take a moment to report a destroyed sandbox as gone.
    for (const deadline = Date.now() + 30_000; ;) {
      const info = await ctx.provider.get(id, { signal: ctx.signal });
      if (!info || info.state === "gone") return;
      if (Date.now() > deadline) throw new Error(`still ${info.state} 30 s after destroy`);
      await sleep(1_000, ctx.signal);
    }
  });
  return { checks };
}
