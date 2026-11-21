// Shapes the playground server sends (see playground/app.ts and playground/runs.ts).

export type TestId = "speed" | "stream" | "desktop" | "agent" | "load" | "workloads" | "capabilities";

export interface ProviderStatus {
  module: string;
  title: string;
  kind: string;
  logo: string | null;
  capabilities: string[];
  available: boolean;
  missing: string[];
  howToEnable: string;
}

export interface ModelInfo {
  id: string;
  /** Null when no price is on record (some OpenAI models): tokens are counted, cost shows as n/a. */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  fallback: boolean;
  estimatePerTaskUsd: number | null;
}

export type Backend = "claude" | "openai";

export interface Overview {
  providers: ProviderStatus[];
  claude: { available: boolean; source: string | null; models: ModelInfo[]; efforts: string[] };
  openai: { available: boolean; source: string | null; models: ModelInfo[]; defaultModel: string };
  tasks: { id: string; title: string; heavy: boolean }[];
  checks: string[];
  limits: { maxLoad: number; maxActiveRuns: number; maxForks: number };
  workloads: { sections: WorkloadSection[]; sizes: number[] };
  liveSandboxes: number;
}

export interface RunSummary {
  id: string;
  test: TestId;
  providers: string[];
  options: Record<string, unknown>;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  results: Record<string, unknown>;
}

export type RunStatus = "running" | "done" | "cancelled" | "failed";

export interface PlaygroundEvent {
  type: "log" | "metric" | "status" | "output" | "agent" | "workload" | "done" | "error";
  provider?: string;
  t: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface Summary { n: number; min: number | null; max: number | null; mean: number | null; p50: number | null; p95: number | null }
export interface Bin { from: number; to: number; count: number }

export interface LoadMetric {
  n: number; done: number; ok: number; errors: Record<string, number>;
  ready: Summary; total: Summary; readyHistogram: Bin[]; totalHistogram: Bin[];
}

export interface TaskResult {
  passed: boolean; wallMs: number; modelMs?: number; toolMs?: number; turns?: number; toolCalls?: number;
  stop?: string; stopMessage?: string; fallbackUsed?: boolean; costUsd?: number | null;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  error?: { kind: string; message: string };
}

export interface StreamLine { n: number; text: string; lagMs: number }

/** Expiring credentials, held only in memory. Never put these in localStorage or an exported run. */
export interface DesktopConnection {
  url: string;
  websocketUrl?: string;
  expiresAt?: string;
  sandboxId: string;
  task?: string;
}

export interface ProviderRun {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  ms?: number;
  error?: { kind: string; message: string };
  logs: { level: string; message: string }[];
  metrics: Record<string, number>;
  lines: StreamLine[];
  lag?: { p50: number; p95: number; max: number; received: number; expected: number };
  clock?: { offsetMs: number; rttMs: number; precise: boolean };
  /** For the Agent test, `task` is the task whose sandbox the URL belongs to. */
  link?: { url: string; port: number; task?: string };
  desktop?: DesktopConnection;
  load?: LoadMetric;
  checks: Record<string, { ok: boolean; ms: number; message?: string }>;
  /** Agent and Workloads steps, in order, for the live terminal. */
  transcript: PlaygroundEvent[];
  tasks: Record<string, TaskResult>;
  /** Workloads: each section's result once it ends. */
  sections: Partial<Record<WorkloadSection, SectionResult>>;
}

export type WorkloadSection = "files" | "persistence" | "fork" | "isolation";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SectionResult { verdict: "pass" | "fail" | "info" | "skip"; summary: string; data?: Record<string, any> }

export interface View {
  runId: string;
  test: TestId;
  providers: string[];
  options: Record<string, unknown>;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  error?: { kind: string; message: string };
  logs: { level: string; message: string }[];
  p: Record<string, ProviderRun>;
}

export interface CredentialField { name: string; secret: boolean; required: boolean; status: "saved" | "env" | "unset" }
export interface CredentialStatus { module: string; title: string; keyUrl: string | null; fields: CredentialField[]; alternatives: string[][] }
export interface ConnectionResult { ok: boolean; kind?: string; code?: string; status?: number; missing?: string[]; ms: number }
