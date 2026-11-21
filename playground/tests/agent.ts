// Agent capability: an agent (Claude, or an OpenAI model, picked by the model name) does each task in a fresh
// sandbox of every selected provider (providers in parallel, tasks one after another), then the harness runs
// the task's verify command, the judge for both backends. Inputs a task needs (a data file, a page to load) are
// written and started by the harness before the agent runs. Every step streams to the UI as it happens: sandbox
// creation, model text, tool calls and their output, the verify result, plus the desktop viewer and a port
// preview where the provider has them. This spends real money on the model API; the UI asks for confirmation
// with an estimate first.
import { execFile } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { EFFORTS, FALLBACK_MODELS, MODELS, PRICES, runAgentLoop, truncate, type AgentClient, type Effort, type ToolExecutor } from "../agent-loop.ts";
import { OPENAI_PRICES, isOpenAIModel, runOpenAIAgentLoop, type OpenAIAgentClient } from "../openai-loop.ts";
import { createSandbox, destroySandbox, elapsed, emitDesktop, emitPortLink, errorInfo, has, intOption, method, waitForState, type TestContext } from "../harness.ts";
import { DEFAULT_TASKS, SYSTEM_PROMPT, taskById, type AgentTask } from "../tasks.ts";

export type Backend = "claude" | "openai";
export const backendOf = (model: string): Backend => isOpenAIModel(model) ? "openai" : "claude";

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
    model: (MODELS as readonly unknown[]).includes(raw.model) || isOpenAIModel(raw.model) ? raw.model as string : "claude-opus-5-5",
    effort: (EFFORTS as readonly unknown[]).includes(raw.effort) ? raw.effort as Effort : "medium",
    tasks: tasks.length ? [...new Set(tasks)] : DEFAULT_TASKS,
    maxTurns: intOption(raw.maxTurns, 25, 1, 25),
    timeLimitMin: intOption(raw.timeLimitMin, 10, 1, 10),
  };
}

/** A model's price per million tokens, or null when none is on record (some OpenAI models). */
export const priceOf = (model: string) => isOpenAIModel(model) ? OPENAI_PRICES[model] ?? null : PRICES[model] ?? PRICES["claude-opus-5-5"]!;

/** Rough token use of one task, for the estimate shown before a run (no cache discount assumed). */
export const ESTIMATE_PER_TASK = { input: 60_000, output: 6_000 };
/** The estimate for `runs` tasks, or null when the model has no known price. */
export const estimateUsd = (model: string, runs: number) => {
  const price = priceOf(model);
  return price ? runs * (ESTIMATE_PER_TASK.input * price.input + ESTIMATE_PER_TASK.output * price.output) / 1e6 : null;
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

/** Whether an OpenAI API key is set (saved in the UI or in the environment). */
export const openaiCredentials = (env: Record<string, string | undefined>) =>
  env.OPENAI_API_KEY ? { available: true, source: "OPENAI_API_KEY" } : { available: false, source: null };

function executor(ctx: TestContext, id: string): ToolExecutor {
  return {
    async runCommand(input, signal) {
      const result = await ctx.provider.exec(id, input.command, { cwd: input.cwd, timeoutMs: (input.timeout ?? 120) * 1000, signal });
      const parts = [`exit code: ${result.exitCode}`];
      if (result.stdout) parts.push(`stdout:\n${truncate(result.stdout, 8_000)}`);
      if (result.stderr) parts.push(`stderr:\n${truncate(result.stderr, 4_000)}`);
      return { content: parts.join("\n"), exec: result };
    },
    async writeFile(input, signal) {
      await ctx.provider.writeFile(id, input.path, input.content, { signal });
      return { content: `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}` };
    },
  };
}

/**
 * Writes a task's files and runs its setup steps, each shown live in the terminal. Background steps run with
 * startBackground, or nohup from a script file where the provider has no background capability.
 */
async function prepareTask(ctx: TestContext, id: string, task: AgentTask, emit: (event: Record<string, unknown>) => void): Promise<void> {
  for (const file of task.files ?? []) await ctx.provider.writeFile(id, file.path, file.content, { signal: ctx.signal });
  for (const [index, step] of (task.setup ?? []).entries()) {
    emit({ kind: "setup", index, label: step.label });
    const started = performance.now();
    let ok = true, output = "";
    if (step.background && has(ctx.provider, "background")) {
      await method<(id: string, command: string, o?: object) => Promise<void>>(ctx.provider, "startBackground")(id, step.command, { cwd: step.cwd, signal: ctx.signal });
    } else {
      const script = `/tmp/open-sb-playground/setup-${task.id}-${index}.sh`;
      if (step.background) await ctx.provider.writeFile(id, script, `${step.cwd ? `cd ${step.cwd} && ` : ""}exec ${step.command}\n`, { signal: ctx.signal });
      const result = await ctx.provider.exec(id, step.background ? `nohup sh ${script} >/dev/null 2>&1 &` : step.command, { cwd: step.background ? undefined : step.cwd, timeoutMs: 300_000, signal: ctx.signal });
      ok = result.exitCode === 0;
      output = truncate(`${result.stdout}${result.stderr}`.trim(), 1_500);
    }
    emit({ kind: "setup_done", index, ok, ms: elapsed(started), output });
    if (!ok) throw new Error(`Setup step "${step.label}" failed: ${output.slice(0, 200)}`);
  }
}

/** The client factories; tests replace them with fakes. A key saved in the UI wins over the environment; without
 * one the Anthropic SDK resolves credentials itself (ANTHROPIC_API_KEY, or an `ant auth login` profile). */
export let makeClient: (env: Record<string, string | undefined>) => AgentClient =
  env => env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : new Anthropic();
export const setClientFactory = (factory: (env: Record<string, string | undefined>) => AgentClient) => { makeClient = factory; };
export let makeOpenAIClient: (env: Record<string, string | undefined>) => OpenAIAgentClient = env => new OpenAI({ apiKey: env.OPENAI_API_KEY });
export const setOpenAIClientFactory = (factory: (env: Record<string, string | undefined>) => OpenAIAgentClient) => { makeOpenAIClient = factory; };

export async function agent(ctx: TestContext) {
  const options = agentOptions(ctx.options);
  const backend = backendOf(options.model);
  const openai = backend === "openai" ? makeOpenAIClient(ctx.env) : undefined;
  const claude = backend === "claude" ? makeClient(ctx.env) : undefined;
  const tasks: Record<string, unknown> = {};
  if (FALLBACK_MODELS.has(options.model)) ctx.emit({ type: "log", level: "info", message: `Refusal fallback is on (fallbacks: "default")` });
  if (backend === "openai" && !OPENAI_PRICES[options.model]) ctx.emit({ type: "log", level: "info", message: `No price on record for ${options.model}: tokens are counted, cost shows as n/a` });

  for (const taskId of options.tasks) {
    const task = taskById.get(taskId)!;
    const emit = (event: Record<string, unknown>) => ctx.emit({ type: "agent", task: task.id, ...event });
    emit({ kind: "task_start", title: task.title, model: options.model, backend });
    const started = performance.now();
    let id: string | undefined;
    // The live views run beside the agent and stop with the task.
    const views = new AbortController();
    const viewSignal = AbortSignal.any([ctx.signal, views.signal]);
    const sideViews: Promise<void>[] = [];
    try {
      emit({ kind: "sandbox", state: "creating" });
      id = await createSandbox(ctx);
      await waitForState(ctx, id, "running");
      emit({ kind: "sandbox", state: "ready", id, ms: elapsed(started) });
      await prepareTask(ctx, id, task, emit);
      const viewFailed = (what: string) => (error: unknown) => { if (!viewSignal.aborted) ctx.emit({ type: "log", level: "warn", message: `${what} failed: ${errorInfo(error).message}` }); };
      if (has(ctx.provider, "desktop")) sideViews.push(emitDesktop(ctx, id, viewSignal, { task: task.id }).catch(viewFailed("Desktop")));
      if (task.port && has(ctx.provider, "ports")) sideViews.push(emitPortLink(ctx, id, task.port, viewSignal, { task: task.id }).catch(viewFailed(`Port ${task.port} URL`)));

      const common = {
        model: options.model, effort: options.effort, system: SYSTEM_PROMPT, prompt: task.prompt,
        tools: executor(ctx, id), maxTurns: options.maxTurns, timeLimitMs: options.timeLimitMin * 60_000,
        signal: ctx.signal, onEvent: (event: object) => emit({ ...event }),
      };
      const run = openai ? await runOpenAIAgentLoop({ client: openai, ...common }) : await runAgentLoop({ client: claude!, ...common });
      emit({ kind: "verify_start", command: task.verify });
      const verifyStarted = performance.now();
      const verify = await ctx.provider.exec(id, task.verify, { timeoutMs: 120_000, signal: ctx.signal });
      const passed = verify.exitCode === 0;
      emit({ kind: "verify", passed, exitCode: verify.exitCode, ms: elapsed(verifyStarted), output: truncate(`${verify.stdout}${verify.stderr}`.trim(), 1_500) });
      tasks[task.id] = {
        passed, wallMs: elapsed(started), modelMs: Math.round(run.modelMs), toolMs: Math.round(run.toolMs),
        turns: run.turns, toolCalls: run.toolCalls, stop: run.stop, stopMessage: run.message, fallbackUsed: run.fallbackUsed,
        tokens: { input: run.usage.input, output: run.usage.output, cacheRead: run.usage.cacheRead, cacheWrite: run.usage.cacheWrite },
        // NaN for a model without a price: sent as null, shown as n/a.
        costUsd: Number.isFinite(run.usage.costUsd) ? Math.round(run.usage.costUsd * 10_000) / 10_000 : null,
      };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const info = errorInfo(error);
      emit({ kind: "stop", reason: "error", message: info.message });
      tasks[task.id] = { passed: false, wallMs: elapsed(started), error: info };
    } finally {
      views.abort();
      await Promise.all(sideViews);
      if (id) {
        emit({ kind: "sandbox", state: "destroying", id });
        await destroySandbox(ctx, id).catch(() => undefined);
      }
    }
    emit({ kind: "task_done", result: tasks[task.id] });
  }
  return { model: options.model, backend, effort: options.effort, tasks };
}
