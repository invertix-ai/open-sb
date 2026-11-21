// Agent capability: a Claude agent does each task in a fresh sandbox of every selected provider (providers
// in parallel, tasks one after another), then the harness runs the task's verify command. This spends real
// money on the Claude API; the UI asks for confirmation with an estimate first.
import { execFile } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORTS, FALLBACK_MODELS, MODELS, PRICES, runAgentLoop, truncate, type AgentClient, type Effort, type ToolExecutor } from "../agent-loop.ts";
import { createSandbox, destroySandbox, elapsed, errorInfo, intOption, waitForState, type TestContext } from "../harness.ts";
import { SYSTEM_PROMPT, TASKS, taskById } from "../tasks.ts";

export interface AgentOptions {
  model: string;
  effort: Effort;
  tasks: string[];
  maxTurns: number;
  timeLimitMin: number;
}

export function agentOptions(raw: Record<string, unknown>): AgentOptions {
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter((id): id is string => typeof id === "string" && taskById.has(id)) : [];
  return {
    model: (MODELS as readonly unknown[]).includes(raw.model) ? raw.model as string : "claude-opus-5-5",
    effort: (EFFORTS as readonly unknown[]).includes(raw.effort) ? raw.effort as Effort : "medium",
    tasks: tasks.length ? [...new Set(tasks)] : TASKS.map(task => task.id),
    maxTurns: intOption(raw.maxTurns, 25, 1, 25),
    timeLimitMin: intOption(raw.timeLimitMin, 10, 1, 10),
  };
}

/** Rough token use of one task, for the estimate shown before a run (no cache discount assumed). */
export const ESTIMATE_PER_TASK = { input: 60_000, output: 6_000 };
export const estimateUsd = (model: string, runs: number) => {
  const price = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  return runs * (ESTIMATE_PER_TASK.input * price.input + ESTIMATE_PER_TASK.output * price.output) / 1e6;
};

let credentialCheck: { at: number; result: Promise<{ available: boolean; source: string | null }> } | undefined;
/** Whether Claude credentials look available: an API key or auth token in the environment, or an `ant auth login` profile. */
export function claudeCredentials(env: Record<string, string | undefined>): Promise<{ available: boolean; source: string | null }> {
  if (env.ANTHROPIC_API_KEY) return Promise.resolve({ available: true, source: "ANTHROPIC_API_KEY" });
  if (env.ANTHROPIC_AUTH_TOKEN) return Promise.resolve({ available: true, source: "ANTHROPIC_AUTH_TOKEN" });
  if (!credentialCheck || Date.now() - credentialCheck.at > 30_000)
    credentialCheck = {
      at: Date.now(),
      result: new Promise(done => execFile("ant", ["auth", "status"], { timeout: 5_000 }, (error, stdout) =>
        done(!error && !/not (logged|signed) in|no active/i.test(stdout) ? { available: true, source: "ant auth profile" } : { available: false, source: null }))),
    };
  return credentialCheck.result;
}

function executor(ctx: TestContext, id: string): ToolExecutor {
  return {
    async runCommand(input, signal) {
      const result = await ctx.provider.exec(id, input.command, { cwd: input.cwd, timeoutMs: (input.timeout ?? 120) * 1000, signal });
      const parts = [`exit code: ${result.exitCode}`];
      if (result.stdout) parts.push(`stdout:\n${truncate(result.stdout, 8_000)}`);
      if (result.stderr) parts.push(`stderr:\n${truncate(result.stderr, 4_000)}`);
      return { content: parts.join("\n") };
    },
    async writeFile(input, signal) {
      await ctx.provider.writeFile(id, input.path, input.content, { signal });
      return { content: `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}` };
    },
  };
}

/** The client factory; tests replace it with a fake. A key saved in the UI wins over the environment; without
 * one the SDK resolves credentials itself (ANTHROPIC_API_KEY, or an `ant auth login` profile). */
export let makeClient: (env: Record<string, string | undefined>) => AgentClient =
  env => env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : new Anthropic();
export const setClientFactory = (factory: (env: Record<string, string | undefined>) => AgentClient) => { makeClient = factory; };

export async function agent(ctx: TestContext) {
  const options = agentOptions(ctx.options);
  const client = makeClient(ctx.env);
  const tasks: Record<string, unknown> = {};
  if (FALLBACK_MODELS.has(options.model)) ctx.emit({ type: "log", level: "info", message: `Refusal fallback is on (fallbacks: "default")` });

  for (const taskId of options.tasks) {
    const task = taskById.get(taskId)!;
    const emit = (event: Record<string, unknown>) => ctx.emit({ type: "agent", task: task.id, ...event });
    emit({ kind: "task_start", title: task.title });
    const started = performance.now();
    let id: string | undefined;
    try {
      id = await createSandbox(ctx);
      await waitForState(ctx, id, "running");
      const run = await runAgentLoop({
        client, model: options.model, effort: options.effort, system: SYSTEM_PROMPT, prompt: task.prompt,
        tools: executor(ctx, id), maxTurns: options.maxTurns, timeLimitMs: options.timeLimitMin * 60_000,
        signal: ctx.signal, onEvent: event => emit({ ...event }),
      });
      const verify = await ctx.provider.exec(id, task.verify, { timeoutMs: 120_000, signal: ctx.signal });
      const passed = verify.exitCode === 0;
      emit({ kind: "verify", passed, exitCode: verify.exitCode, output: truncate(`${verify.stdout}${verify.stderr}`.trim(), 1_500) });
      tasks[task.id] = {
        passed, wallMs: elapsed(started), modelMs: Math.round(run.modelMs), toolMs: Math.round(run.toolMs),
        turns: run.turns, toolCalls: run.toolCalls, stop: run.stop, stopMessage: run.message, fallbackUsed: run.fallbackUsed,
        tokens: { input: run.usage.input, output: run.usage.output, cacheRead: run.usage.cacheRead, cacheWrite: run.usage.cacheWrite },
        costUsd: Math.round(run.usage.costUsd * 10_000) / 10_000,
      };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const info = errorInfo(error);
      emit({ kind: "stop", reason: "error", message: info.message });
      tasks[task.id] = { passed: false, wallMs: elapsed(started), error: info };
    } finally {
      if (id) await destroySandbox(ctx, id).catch(() => undefined);
    }
    emit({ kind: "task_done", result: tasks[task.id] });
  }
  return { model: options.model, effort: options.effort, tasks };
}
