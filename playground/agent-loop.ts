// The agent tool loop: Claude works in one sandbox through `run_command` and `write_file` until it stops
// asking for tools, runs out of turns or time, refuses, or hits max_tokens. A manual loop on the beta
// Messages endpoint (for server-side refusal fallback), with the client and the sandbox injected so tests can
// drive it without the network. Inputs are validated before any tool runs; tool failures go back to Claude
// as tool results with is_error set; parallel tool calls run together and return in one user message.
// The tool runner, events and result shape here are shared with the OpenAI loop (openai-loop.ts).
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool, BetaToolResultBlockParam,
  BetaToolUseBlock, MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type Model = (typeof MODELS)[number];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Models that get server-side refusal fallback (`fallbacks: "default"`). Haiku 5.5 has none. */
export const FALLBACK_MODELS = new Set<string>(["claude-opus-5-5", "claude-sonnet-5-5"]);
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** USD per million tokens. Cache writes are the 5-minute TTL (1.25x input). Fallback targets included. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/** The one method of the SDK client the loop uses, so tests can pass a fake. */
export interface AgentClient {
  beta: { messages: { create(body: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<BetaMessage> } };
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** A command's raw result, for the live terminal in the UI (the model gets `content`). */
  exec?: { exitCode: number; stdout: string; stderr: string };
}

/** Runs validated tool inputs in the sandbox. */
export interface ToolExecutor {
  runCommand(input: RunCommandInput, signal: AbortSignal): Promise<ToolOutput>;
  writeFile(input: WriteFileInput, signal: AbortSignal): Promise<ToolOutput>;
}

export interface RunCommandInput { command: string; cwd?: string; timeout?: number }
export interface WriteFileInput { path: string; content: string }

export const TOOLS: BetaTool[] = [
  {
    name: "run_command",
    description: "Run a shell command (sh -c) in the sandbox and get its exit code, stdout and stderr. Call it whenever you need to inspect, install, build, run or test something. Each call is a new shell.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        cwd: { type: "string", description: "Absolute working directory. Default: the sandbox's default directory." },
        timeout: { type: "integer", description: "Seconds before the command is killed, 1 to 600. Default 120." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Write a whole text file in the sandbox, creating parent directories. Call it to create or replace source files instead of using shell heredocs.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
        content: { type: "string", description: "The complete file contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const extraKeys = (input: Record<string, unknown>, allowed: string[]) => Object.keys(input).filter(key => !allowed.includes(key));

export function validateRunCommand(input: unknown): Validated<RunCommandInput> {
  if (!isObject(input)) return { ok: false, error: "input must be an object" };
  const extra = extraKeys(input, ["command", "cwd", "timeout"]);
  if (extra.length) return { ok: false, error: `unknown fields: ${extra.join(", ")}` };
  if (typeof input.command !== "string" || input.command.trim() === "") return { ok: false, error: "command must be a non-empty string" };
  if (input.command.length > 20_000) return { ok: false, error: "command is longer than 20000 characters" };
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.startsWith("/"))) return { ok: false, error: "cwd must be an absolute path" };
  if (input.timeout !== undefined && (!Number.isInteger(input.timeout) || (input.timeout as number) < 1 || (input.timeout as number) > 600))
    return { ok: false, error: "timeout must be a whole number of seconds from 1 to 600" };
  return { ok: true, value: { command: input.command, cwd: input.cwd as string | undefined, timeout: input.timeout as number | undefined } };
}

export function validateWriteFile(input: unknown): Validated<WriteFileInput> {
  if (!isObject(input)) return { ok: false, error: "input must be an object" };
  const extra = extraKeys(input, ["path", "content"]);
  if (extra.length) return { ok: false, error: `unknown fields: ${extra.join(", ")}` };
  if (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.endsWith("/")) return { ok: false, error: "path must be an absolute file path" };
  if (typeof input.content !== "string") return { ok: false, error: "content must be a string" };
  if (Buffer.byteLength(input.content) > 1_000_000) return { ok: false, error: "content is larger than 1 MB" };
  return { ok: true, value: { path: input.path, content: input.content } };
}

/** Keeps the start and the end of long text, which is where errors and results usually are. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} characters cut] ...\n${text.slice(-tail)}`;
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }

/** Adds one response's usage. `usage.iterations` is the per-attempt record when present (fallbacks). */
export function addUsage(total: Usage, message: BetaMessage, requested: string): void {
  const price = (model: string | null | undefined) => PRICES[model ?? ""] ?? PRICES[requested] ?? PRICES["claude-opus-5-5"]!;
  const entries = message.usage.iterations?.length
    ? message.usage.iterations.map(entry => ({
      model: "model" in entry ? entry.model : null,
      input: entry.input_tokens, output: entry.output_tokens,
      cacheRead: entry.cache_read_input_tokens ?? 0, cacheWrite: entry.cache_creation_input_tokens ?? 0,
    }))
    : [{
      model: message.model, input: message.usage.input_tokens, output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0, cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    }];
  for (const entry of entries) {
    const p = price(entry.model);
    total.input += entry.input;
    total.output += entry.output;
    total.cacheRead += entry.cacheRead;
    total.cacheWrite += entry.cacheWrite;
    total.costUsd += (entry.input * p.input + entry.output * p.output + entry.cacheRead * p.cacheRead + entry.cacheWrite * p.cacheWrite) / 1e6;
  }
}

/**
 * The assistant content to send back. After a fallback, only text (and the fallback blocks themselves, in
 * place) is echoed from before the last fallback block; thinking and tool calls there belong to the model
 * that declined.
 */
export function echoContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const boundary = content.findLastIndex(block => block.type === "fallback");
  return content.filter((block, index) => index > boundary || block.type === "text" || block.type === "fallback") as BetaContentBlockParam[];
}

export type AgentEvent =
  | { kind: "turn"; turn: number; stopReason: string | null; model: string; ms: number }
  | { kind: "text"; text: string }
  | { kind: "fallback"; from: string; to: string }
  | { kind: "tool_call"; id: string; name: string; input: string; command?: string; cwd?: string; path?: string; bytes?: number }
  | { kind: "tool_result"; id: string; name: string; isError: boolean; content: string; ms: number; exitCode?: number; stdout?: string; stderr?: string }
  | { kind: "stop"; reason: string; message?: string };

export type StopReason = "end_turn" | "refusal" | "max_tokens" | "max_turns" | "time_limit" | "api_error" | "no_tool_call" | string;

export interface AgentRunResult {
  stop: StopReason;
  message?: string;
  turns: number;
  toolCalls: number;
  modelMs: number;
  toolMs: number;
  usage: Usage;
  fallbackUsed: boolean;
  finalText: string;
}

export interface AgentLoopOptions {
  client: AgentClient;
  model: string;
  effort: Effort;
  prompt: string;
  system: string;
  tools: ToolExecutor;
  maxTurns: number;
  /** Wall-clock limit for the whole loop. */
  timeLimitMs: number;
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  maxTokens?: number;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const emit = options.onEvent ?? (() => {});
  const deadline = AbortSignal.timeout(options.timeLimitMs);
  const signal = AbortSignal.any([options.signal, deadline]);
  const messages: BetaMessageParam[] = [{ role: "user", content: options.prompt }];
  const result: AgentRunResult = {
    stop: "end_turn", turns: 0, toolCalls: 0, modelMs: 0, toolMs: 0, fallbackUsed: false, finalText: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  };
  const stop = (reason: StopReason, message?: string) => {
    result.stop = reason;
    if (message) result.message = message;
    emit({ kind: "stop", reason, message });
    return result;
  };
  const fallback = FALLBACK_MODELS.has(options.model);

  for (;;) {
    if (result.turns >= options.maxTurns) return stop("max_turns", `Stopped after ${options.maxTurns} turns`);
    if (deadline.aborted) return stop("time_limit", `Stopped after ${Math.round(options.timeLimitMs / 1000)} s`);
    result.turns++;
    const started = performance.now();
    let response: BetaMessage;
    try {
      response = await options.client.beta.messages.create({
        model: options.model,
        max_tokens: options.maxTokens ?? 16_000,
        system: options.system,
        messages,
        tools: TOOLS,
        tool_choice: { type: "auto" },
        output_config: { effort: options.effort },
        // Automatic prompt caching: each turn re-reads the conversation so far from the cache.
        cache_control: { type: "ephemeral" },
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      }, { signal });
    } catch (error) {
      result.modelMs += performance.now() - started;
      if (options.signal.aborted) throw error;
      if (deadline.aborted) return stop("time_limit", `Stopped after ${Math.round(options.timeLimitMs / 1000)} s`);
      if (error instanceof Anthropic.APIError) return stop("api_error", `${error.status ?? ""} ${error.message}`.trim().slice(0, 300));
      throw error;
    }
    const ms = performance.now() - started;
    result.modelMs += ms;
    addUsage(result.usage, response, options.model);
    emit({ kind: "turn", turn: result.turns, stopReason: response.stop_reason, model: response.model, ms: Math.round(ms) });

    for (const block of response.content) {
      if (block.type === "fallback") {
        result.fallbackUsed = true;
        emit({ kind: "fallback", from: block.from.model, to: block.to.model });
      } else if (block.type === "text" && block.text.trim()) {
        result.finalText = block.text;
        emit({ kind: "text", text: truncate(block.text, 4_000) });
      }
    }
    if (response.usage.iterations?.some(entry => entry.type === "fallback_message")) result.fallbackUsed = true;

    // A refusal can cut a tool call off mid-input, and max_tokens can truncate one: never run those tools.
    if (response.stop_reason === "refusal") return stop("refusal", response.stop_details?.category ? `Refused (${response.stop_details.category})` : "Refused");
    if (response.stop_reason === "max_tokens") return stop("max_tokens", "The response hit max_tokens");
    if (response.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: echoContent(response.content) }); continue; }
    if (response.stop_reason !== "tool_use") return stop(response.stop_reason ?? "end_turn");

    const boundary = response.content.findLastIndex(block => block.type === "fallback");
    const calls = response.content.filter((block, index): block is BetaToolUseBlock => index > boundary && block.type === "tool_use");
    if (calls.length === 0) return stop("no_tool_call", "stop_reason was tool_use but no tool call came back");
    messages.push({ role: "assistant", content: echoContent(response.content) });

    const toolStarted = performance.now();
    const results = await Promise.all(calls.map(call => runTool(call, options.tools, signal, emit)));
    result.toolMs += performance.now() - toolStarted;
    result.toolCalls += calls.length;
    if (options.signal.aborted) throw options.signal.reason;
    messages.push({ role: "user", content: results });
  }
}

async function runTool(call: BetaToolUseBlock, tools: ToolExecutor, signal: AbortSignal, emit: (event: AgentEvent) => void): Promise<BetaToolResultBlockParam> {
  const output = await executeTool({ id: call.id, name: call.name, input: call.input }, tools, signal, emit);
  return { type: "tool_result", tool_use_id: call.id, content: output.content, ...(output.isError ? { is_error: true } : {}) };
}

/** What the UI shows of a call before it returns: the command and its directory, or the path and size written. */
function describeInput(name: string, input: unknown): Pick<Extract<AgentEvent, { kind: "tool_call" }>, "command" | "cwd" | "path" | "bytes"> {
  if (!isObject(input)) return {};
  if (name === "run_command" && typeof input.command === "string")
    return { command: truncate(input.command, 2_000), ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}) };
  if (name === "write_file" && typeof input.path === "string")
    return { path: input.path, ...(typeof input.content === "string" ? { bytes: Buffer.byteLength(input.content) } : {}) };
  return {};
}

/**
 * Validates and runs one tool call, emitting `tool_call` before and `tool_result` after. Failures come back as
 * an error result, never as a throw. Returns the content for the model, truncated to 12,000 characters.
 */
export async function executeTool(call: { id: string; name: string; input: unknown }, tools: ToolExecutor, signal: AbortSignal, emit: (event: AgentEvent) => void): Promise<ToolOutput> {
  emit({ kind: "tool_call", id: call.id, name: call.name, input: truncate(JSON.stringify(call.input) ?? "", 2_000), ...describeInput(call.name, call.input) });
  const started = performance.now();
  let output: ToolOutput;
  try {
    if (call.name === "run_command") {
      const input = validateRunCommand(call.input);
      output = input.ok ? await tools.runCommand(input.value, signal) : { content: `Invalid input: ${input.error}`, isError: true };
    } else if (call.name === "write_file") {
      const input = validateWriteFile(call.input);
      output = input.ok ? await tools.writeFile(input.value, signal) : { content: `Invalid input: ${input.error}`, isError: true };
    } else {
      output = { content: `Unknown tool ${call.name}`, isError: true };
    }
  } catch (error) {
    output = { content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000), isError: true };
  }
  const content = truncate(output.content, 12_000);
  emit({
    kind: "tool_result", id: call.id, name: call.name, isError: Boolean(output.isError), content: truncate(content, 2_000), ms: Math.round(performance.now() - started),
    ...(output.exec ? { exitCode: output.exec.exitCode, stdout: truncate(output.exec.stdout, 6_000), stderr: truncate(output.exec.stderr, 3_000) } : {}),
  });
  return { content, isError: output.isError };
}
