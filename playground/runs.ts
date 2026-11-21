// Runs and their event logs. Every event a test emits is kept, so a subscriber that arrives late (or a
// browser that reconnects) gets the whole history replayed before live events; the run history and the JSON
// export read the same log. Runs live in memory only.
import { randomBytes } from "node:crypto";

export type EventType = "log" | "metric" | "status" | "output" | "agent" | "workload" | "done" | "error";

export interface PlaygroundEvent {
  type: EventType;
  /** Provider module name; absent for run-level events. */
  provider?: string;
  /** Milliseconds since the run started. */
  t: number;
  [key: string]: unknown;
}

/** What tests call to report progress. `t` is filled in by the run. */
export type Emit = (event: { type: EventType; provider?: string; [key: string]: unknown }) => void;

export type RunStatus = "running" | "done" | "cancelled" | "failed";

export interface RunSummary {
  id: string;
  test: string;
  providers: string[];
  options: Record<string, unknown>;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  results: Record<string, unknown>;
}

type Listener = (event: PlaygroundEvent, index: number) => void;

export class Run {
  readonly id: string;
  readonly test: string;
  readonly providers: string[];
  readonly options: Record<string, unknown>;
  readonly startedAt = new Date();
  readonly controller = new AbortController();
  readonly events: PlaygroundEvent[] = [];
  readonly results: Record<string, unknown> = {};
  status: RunStatus = "running";
  endedAt?: Date;
  private readonly listeners = new Set<Listener>();
  private readonly redact: (text: string) => string;

  constructor(test: string, providers: string[], options: Record<string, unknown>, redact: (text: string) => string = text => text) {
    // Lowercase letters, digits and dashes: valid as a label value on every provider.
    this.id = `r${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    this.test = test;
    this.providers = providers;
    this.options = options;
    this.redact = redact;
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get finished(): boolean { return this.status !== "running"; }

  /** Records an event and hands it to every subscriber. Secrets are redacted before anything is stored. */
  readonly emit: Emit = event => {
    if (this.finished) return;
    const stored = JSON.parse(this.redact(JSON.stringify({ ...event, t: Date.now() - this.startedAt.getTime() }))) as PlaygroundEvent;
    const index = this.events.push(stored) - 1;
    for (const listener of this.listeners) listener(stored, index);
  };

  /** Ends the run with a final `done` event; later events are dropped. */
  finish(status: Exclude<RunStatus, "running">): void {
    if (this.finished) return;
    this.emit({ type: "done", status, results: this.results });
    this.status = status;
    this.endedAt = new Date();
  }

  /** Replays events from `from` (an index), then delivers live ones until the returned function is called. */
  subscribe(listener: Listener, from = 0): () => void {
    for (let i = Math.max(0, from); i < this.events.length; i++) listener(this.events[i]!, i);
    if (this.finished) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary(): RunSummary {
    return {
      id: this.id, test: this.test, providers: this.providers, options: this.options, status: this.status,
      startedAt: this.startedAt.toISOString(), endedAt: this.endedAt?.toISOString(), results: this.results,
    };
  }
}

/** Keeps the most recent runs; older finished ones are dropped. */
export class RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly keep: number;
  constructor(keep = 50) { this.keep = keep; }

  add(run: Run): void {
    this.runs.set(run.id, run);
    for (const old of this.runs.values()) {
      if (this.runs.size <= this.keep) break;
      if (old.finished) this.runs.delete(old.id);
    }
  }

  get(id: string): Run | undefined { return this.runs.get(id); }
  all(): Run[] { return [...this.runs.values()].reverse(); }
  active(): Run[] { return this.all().filter(run => !run.finished); }
}
