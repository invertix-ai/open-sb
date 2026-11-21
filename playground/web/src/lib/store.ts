// Client state: the provider overview, selection, options per test, and one live view per tab (the last run
// shown there). Run events arrive over Server-Sent Events, which replay the whole run to a late subscriber.
// Views are mutated in place and components re-render on a version number, batched to one per frame.
import { useSyncExternalStore } from "react";
import { api, post } from "./api";
import type { Overview, PlaygroundEvent, ProviderRun, RunSummary, TestId, View } from "./types";

const stored = <T>(key: string, fallback: T): T => {
  try { return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback; } catch { return fallback; }
};

export interface Options {
  speed: { rounds: number; fileMiB: number; pause: boolean };
  stream: { durationS: number; intervalMs: number; pollMs: number };
  agent: { model: string; effort: string; tasks: string[] | null; maxTurns: number; timeLimitMin: number };
  load: { n: number };
  capabilities: Record<string, never>;
}

const DEFAULT_OPTIONS: Options = {
  speed: { rounds: 10, fileMiB: 1, pause: true },
  stream: { durationS: 15, intervalMs: 200, pollMs: 400 },
  agent: { model: "claude-opus-5-5", effort: "medium", tasks: null, maxTurns: 25, timeLimitMin: 10 },
  load: { n: 5 },
  capabilities: {},
};

export const TESTS: { id: TestId; label: string; blurb: string }[] = [
  { id: "speed", label: "Speed", blurb: "Create, exec, file transfer, pause, resume and destroy timings." },
  { id: "stream", label: "Live stream", blurb: "A background process writes a line every interval; see how fast lines arrive." },
  { id: "agent", label: "Agent", blurb: "A Claude agent works through real tasks inside each sandbox." },
  { id: "load", label: "Load", blurb: "Many sandboxes at once: success rate, errors and latency spread." },
  { id: "capabilities", label: "Capabilities", blurb: "Declared capabilities, and a quick check of the core interface." },
];

const newProviderRun = (): ProviderRun => ({ status: "queued", logs: [], metrics: {}, lines: [], checks: {}, transcript: [], tasks: {} });

class Store {
  overview: Overview | null = null;
  overviewError: string | null = null;
  selected = new Set<string>(stored<string[]>("osb.selected", ["docker"]));
  tab: TestId = TESTS.some(test => test.id === localStorage.getItem("osb.tab")) ? localStorage.getItem("osb.tab") as TestId : "speed";
  options: Options = { ...DEFAULT_OPTIONS, ...stored<Partial<Options>>("osb.options.v2", {}) };
  views: Partial<Record<TestId, View>> = {};
  history: RunSummary[] = [];
  live = 0;
  theme: "dark" | "light" = localStorage.getItem("osb.theme") === "light" ? "light" : "dark";
  setupModule: string | null = null;
  version = 0;
  private listeners = new Set<() => void>();
  private frame = 0;
  private sources = new Map<string, EventSource>();

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.version;
  /** Re-render now. */
  notify = () => { this.version++; for (const listener of this.listeners) listener(); };
  /** Re-render on the next frame, however many events arrive before it. */
  schedule = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.notify(); });
  };

  get order() { return this.overview?.providers.map(entry => entry.module) ?? []; }
  provider(module: string) { return this.overview?.providers.find(entry => entry.module === module); }
  selectedAvailable() { return (this.overview?.providers ?? []).filter(entry => entry.available && this.selected.has(entry.module)).map(entry => entry.module); }

  async loadOverview() {
    try {
      this.overview = await api<Overview>("/api/providers");
      this.overviewError = null;
      this.live = this.overview.liveSandboxes;
      for (const module of [...this.selected]) if (!this.provider(module)?.available) this.selected.delete(module);
      if (!this.overview.claude.models.some(model => model.id === this.options.agent.model)) this.options.agent.model = this.overview.claude.models[0]?.id ?? "claude-opus-5-5";
    } catch (error) {
      this.overviewError = (error as Error).message;
    }
    this.notify();
  }

  async pollStatus() {
    try { this.live = (await api<{ liveSandboxes: number }>("/api/status")).liveSandboxes; this.notify(); } catch { /* restarting */ }
  }

  async refreshHistory() {
    try { this.history = (await api<{ runs: RunSummary[] }>("/api/runs")).runs; this.notify(); } catch { /* keep the old list */ }
  }

  setTab(tab: TestId) { this.tab = tab; localStorage.setItem("osb.tab", tab); this.notify(); }

  toggle(module: string, on?: boolean) {
    if (!this.provider(module)?.available) return;
    const next = on ?? !this.selected.has(module);
    if (next) this.selected.add(module); else this.selected.delete(module);
    localStorage.setItem("osb.selected", JSON.stringify([...this.selected]));
    this.notify();
  }

  selectAll(on: boolean) {
    for (const entry of this.overview?.providers ?? []) if (entry.available) { if (on) this.selected.add(entry.module); else this.selected.delete(entry.module); }
    localStorage.setItem("osb.selected", JSON.stringify([...this.selected]));
    this.notify();
  }

  setOption<T extends TestId>(test: T, key: keyof Options[T], value: unknown) {
    (this.options[test] as Record<string, unknown>)[key as string] = value;
    localStorage.setItem("osb.options.v2", JSON.stringify(this.options));
    this.notify();
  }

  setTheme(theme: "dark" | "light") {
    this.theme = theme;
    localStorage.setItem("osb.theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
    this.notify();
  }

  openSetup(module: string | null) { this.setupModule = module; this.notify(); }

  async start(test: TestId) {
    const providers = this.selectedAvailable();
    const options = { ...this.options[test] } as Record<string, unknown>;
    if (test === "agent" && !options.tasks) options.tasks = this.overview?.tasks.map(task => task.id);
    const { runId } = await post<{ runId: string }>("/api/runs", { test, providers, options });
    this.open({ id: runId, test, providers, options, status: "running", startedAt: new Date().toISOString(), results: {} });
  }

  async cancel(test: TestId) {
    const view = this.views[test];
    if (view) await post(`/api/runs/${encodeURIComponent(view.runId)}/cancel`);
  }

  /** Shows a run in its tab and streams its events (all of them, replayed from the start). */
  open(summary: RunSummary) {
    const old = this.views[summary.test];
    if (old) { this.sources.get(old.runId)?.close(); this.sources.delete(old.runId); }
    const view: View = {
      runId: summary.id, test: summary.test, providers: summary.providers, options: summary.options,
      status: summary.status, startedAt: Date.parse(summary.startedAt), endedAt: summary.endedAt ? Date.parse(summary.endedAt) : undefined,
      logs: [], p: Object.fromEntries(summary.providers.map(module => [module, newProviderRun()])),
    };
    this.views[summary.test] = view;
    this.setTab(summary.test);
    const source = new EventSource(`/api/runs/${encodeURIComponent(view.runId)}/events`);
    this.sources.set(view.runId, source);
    source.onmessage = message => {
      const event = JSON.parse(message.data) as PlaygroundEvent;
      this.apply(view, event);
      if (event.type === "done") { source.close(); this.sources.delete(view.runId); }
    };
    // The browser reconnects with Last-Event-ID; once the run is over there is nothing left to wait for.
    source.onerror = () => { if (view.status !== "running") { source.close(); this.sources.delete(view.runId); } };
  }

  private apply(view: View, event: PlaygroundEvent) {
    const p = event.provider ? (view.p[event.provider] ??= newProviderRun()) : null;
    switch (event.type) {
      case "status":
        if (p) { p.status = event.status; p.ms = event.ms; }
        break;
      case "error":
        if (p) p.error = { kind: event.kind, message: event.message }; else view.error = { kind: event.kind, message: event.message };
        break;
      case "log":
        (p ? p.logs : view.logs).push({ level: event.level ?? "info", message: event.message });
        if (p && p.logs.length > 200) p.logs.splice(0, p.logs.length - 200);
        break;
      case "metric":
        if (!p) break;
        if (event.name === "lag") p.lag = event as unknown as ProviderRun["lag"];
        else if (event.name === "clock") p.clock = event as unknown as ProviderRun["clock"];
        else if (event.name === "load") p.load = event as unknown as ProviderRun["load"];
        else if (event.name === "check") p.checks[event.check] = { ok: event.ok, ms: event.ms, message: event.message };
        else p.metrics[event.name] = event.value;
        break;
      case "output":
        if (!p) break;
        if (event.kind === "lines") {
          p.lines.push(...event.lines);
          if (p.lines.length > 2000) p.lines.splice(0, p.lines.length - 2000);
        } else if (event.kind === "link") p.link = { url: event.url, port: event.port };
        else if (event.kind === "desktop") p.desktop = { url: event.url };
        break;
      case "agent":
        if (!p) break;
        if (event.kind === "task_done") p.tasks[event.task] = event.result;
        else { p.transcript.push(event); if (p.transcript.length > 1000) p.transcript.splice(0, p.transcript.length - 1000); }
        break;
      case "done":
        view.status = event.status;
        view.endedAt = view.startedAt + event.t;
        void this.refreshHistory();
        void this.pollStatus();
        break;
    }
    this.schedule();
  }
}

export const store = new Store();

/** Subscribes a component to the store; returns the store itself. */
export function useStore() {
  useSyncExternalStore(store.subscribe, store.snapshot);
  return store;
}
