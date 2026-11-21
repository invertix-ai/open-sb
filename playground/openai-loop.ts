// The same agent tool loop on OpenAI's Responses API: the model works in one sandbox through `run_command` and
// `write_file` (strict function tools) until it answers without a function call, runs out of turns or time,
// refuses, or hits max_output_tokens. Stateless (`store: false`): every turn sends the whole conversation,
// with reasoning items carried as encrypted content, and the function results as `function_call_output` items
// matched by `call_id`. Tools run through the shared runner in agent-loop.ts, so validation, events and the
// result shape are the same as for Claude; the client and the sandbox are injected so tests need no network.
import OpenAI from "openai";
import type {
  FunctionTool, Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, ResponseInputItem,
} from "openai/resources/responses/responses";
import { TOOLS, executeTool, truncate, type AgentEvent, type AgentLoopOptions, type AgentRunResult, type StopReason, type Usage } from "./agent-loop.ts";

export const OPENAI_MODELS = ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-luna"] as const;
export const OPENAI_DEFAULT_MODEL = "gpt-6.1-sol";
export const isOpenAIModel = (model: unknown) => (OPENAI_MODELS as readonly unknown[]).includes(model);

/**
 * USD per million tokens, only where a price is on record: gpt-6-luna's are the summary-model defaults in
 * agent-platform's server/env.ts (INVERTIX_SUMMARY_*_PRICE_MICROUSD_PER_MILLION: 100000 input, 10000 cached
 * input, 500000 output), with cache writes at 1.25x input as agent-platform's server/runs/gateway.ts
 * (tokenUnits) charges them when a model has no cache-write price. The other models have no price there
 * (deployment settings, default 0), so their cost shows as n/a.
 */
export const OPENAI_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** The one method of the SDK client the loop uses, so tests can pass a fake. */
export interface OpenAIAgentClient {
  responses: { create(body: ResponseCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<Response> };
}

/**
 * The Claude tool schemas as strict function tools. Strict mode needs every property listed in `required`, so
 * the optional ones also accept null; nulls are dropped before validation.
 */
export const OPENAI_TOOLS: FunctionTool[] = TOOLS.map(tool => {
  const schema = tool.input_schema as { properties: Record<string, { type: string; description?: string }>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) =>
    [name, required.has(name) ? property : { ...property, type: [property.type, "null"] }]));
  return {
    type: "function", name: tool.name, description: tool.description ?? null, strict: true,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  };
});

/** Parses a call's JSON arguments and drops nulls (optional fields under strict mode). */
export function parseArguments(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return text; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}

/**
 * Adds one response's usage. `input_tokens` includes cached reads and cache writes, so uncached input is the
 * rest. Unpriced models count tokens only, and `costUsd` stays NaN for them.
 */
export function addOpenAIUsage(total: Usage, response: Response, model: string): void {
  const usage = response.usage;
  if (!usage) return;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, usage.input_tokens - cacheRead - cacheWrite);
  total.input += input;
  total.output += usage.output_tokens;
  total.cacheRead += cacheRead;
  total.cacheWrite += cacheWrite;
  const price = OPENAI_PRICES[model];
  total.costUsd += price ? (input * price.input + usage.output_tokens * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1e6 : NaN;
}

/** Output items to send back next turn: messages, reasoning (encrypted) and function calls. */
const echoable = (response: Response) => response.output.filter(item => item.type === "message" || item.type === "reasoning" || item.type === "function_call") as ResponseInputItem[];

export interface OpenAIAgentLoopOptions extends Omit<AgentLoopOptions, "client"> {
  client: OpenAIAgentClient;
}

export async function runOpenAIAgentLoop(options: OpenAIAgentLoopOptions): Promise<AgentRunResult> {
  const emit = options.onEvent ?? ((_event: AgentEvent) => {});
  const deadline = AbortSignal.timeout(options.timeLimitMs);
  const signal = AbortSignal.any([options.signal, deadline]);
  const input: ResponseInputItem[] = [{ role: "user", content: options.prompt }];
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

  for (;;) {
    if (result.turns >= options.maxTurns) return stop("max_turns", `Stopped after ${options.maxTurns} turns`);
    if (deadline.aborted) return stop("time_limit", `Stopped after ${Math.round(options.timeLimitMs / 1000)} s`);
    result.turns++;
    const started = performance.now();
    let response: Response;
    try {
      response = await options.client.responses.create({
        model: options.model,
        instructions: options.system,
        input,
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning: { effort: options.effort },
        max_output_tokens: options.maxTokens ?? 16_000,
        store: false,
        include: ["reasoning.encrypted_content"],
      }, { signal });
    } catch (error) {
      result.modelMs += performance.now() - started;
      if (options.signal.aborted) throw error;
      if (deadline.aborted) return stop("time_limit", `Stopped after ${Math.round(options.timeLimitMs / 1000)} s`);
      if (error instanceof OpenAI.APIError) return stop("api_error", `${error.status ?? ""} ${error.message}`.trim().slice(0, 300));
      throw error;
    }
    const ms = performance.now() - started;
    result.modelMs += ms;
    addOpenAIUsage(result.usage, response, options.model);

    const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
    const incomplete = response.status === "incomplete" ? response.incomplete_details?.reason ?? "incomplete" : null;
    emit({ kind: "turn", turn: result.turns, stopReason: incomplete ?? (calls.length ? "function_call" : response.status ?? null), model: response.model, ms: Math.round(ms) });

    let refusal: string | undefined;
    for (const item of response.output) {
      if (item.type !== "message") continue;
      for (const part of item.content) {
        if (part.type === "refusal") refusal = part.refusal;
        else if (part.text.trim()) { result.finalText = part.text; emit({ kind: "text", text: truncate(part.text, 4_000) }); }
      }
    }

    if (response.status === "failed") return stop("api_error", response.error ? `${response.error.code}: ${response.error.message}`.slice(0, 300) : "The response failed");
    // A cut-off response can hold a half-written call: never run tools from one.
    if (refusal !== undefined || incomplete === "content_filter") return stop("refusal", refusal ? `Refused: ${truncate(refusal, 200)}` : "Refused (content filter)");
    if (incomplete === "max_output_tokens") return stop("max_tokens", "The response hit max_output_tokens");
    if (incomplete) return stop(incomplete, `The response is incomplete (${incomplete})`);
    if (calls.length === 0) return stop("end_turn");

    input.push(...echoable(response));
    const toolStarted = performance.now();
    const outputs = await Promise.all(calls.map(call => executeTool({ id: call.call_id, name: call.name, input: parseArguments(call.arguments) }, options.tools, signal, emit)));
    result.toolMs += performance.now() - toolStarted;
    result.toolCalls += calls.length;
    if (options.signal.aborted) throw options.signal.reason;
    // The Responses API has no error flag on a function result; the text says it.
    calls.forEach((call, index) => input.push({ type: "function_call_output", call_id: call.call_id, output: outputs[index]!.isError ? `Error: ${outputs[index]!.content}` : outputs[index]!.content }));
  }
}
