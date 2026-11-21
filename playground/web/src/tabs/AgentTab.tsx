// Agent: Claude works through the task suite in each provider's sandboxes. Pass rate, cost so far and a token
// breakdown on top, a results grid, and a live transcript per provider.
import { useEffect, useLayoutEffect, useRef } from "react";
import { ChevronRight, KeyRound, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ComparisonBars, TokenBars } from "@/components/charts";
import { CounterStat, ProviderCard, Stat } from "@/components/ProviderCard";
import { ContextMeter } from "@/bencho/context-meter/ContextMeter";
import "@/bencho/context-meter/ContextMeter.css";
import { ProviderLogo } from "@/components/ProviderLogo";
import { ChartCard, Field, TestLayout } from "@/components/TestLayout";
import { colorFor, fmt } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { PlaygroundEvent, TaskResult, View } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NumberInput, winnerOf } from "./SpeedTab";

function describeCall(name: string, input: string) {
  try {
    const value = JSON.parse(input) as { command?: string; cwd?: string; path?: string; content?: string };
    if (name === "run_command") return `${value.cwd ? `[${value.cwd}] ` : ""}${value.command}`;
    if (name === "write_file") return `${value.path} (${(value.content ?? "").length} chars)`;
  } catch { /* truncated input: shown raw */ }
  return input;
}

function Entry({ event }: { event: PlaygroundEvent }) {
  switch (event.kind) {
    case "task_start": return <div className="mt-3 rounded-md bg-muted px-2.5 py-1.5 text-xs font-semibold first:mt-0">{event.title}</div>;
    case "turn": return <div className="mt-2 font-mono text-[10.5px] text-muted-foreground">turn {event.turn} · {fmt(event.ms, "ms")} · {event.stopReason}</div>;
    case "text": return <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">{event.text}</p>;
    case "fallback": return <div className="font-mono text-[11px] text-warning">{event.from} declined; {event.to} continued</div>;
    case "tool_call": return (
      <div className="flex items-baseline gap-2">
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">{event.name}</Badge>
        <code className="line-clamp-3 break-all font-mono text-[11.5px] text-sidebar-primary">{describeCall(event.name, event.input)}</code>
      </div>
    );
    case "tool_result": return (
      <Collapsible>
        <CollapsibleTrigger className={cn("group flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground hover:text-foreground", event.isError && "text-destructive")}>
          <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />{event.isError ? "error" : "result"} · {fmt(event.ms, "ms")}
        </CollapsibleTrigger>
        <CollapsibleContent><pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px]">{event.content}</pre></CollapsibleContent>
      </Collapsible>
    );
    case "stop": return <div className={cn("font-mono text-[11px]", event.reason === "end_turn" ? "text-muted-foreground" : "text-warning")}>stopped: {event.reason}{event.message ? ` (${event.message})` : ""}</div>;
    case "verify": return (
      <Collapsible>
        <CollapsibleTrigger className={cn("group flex items-center gap-1 text-xs font-semibold", event.passed ? "text-success" : "text-destructive")}>
          <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />verify {event.passed ? "passed" : `failed (exit ${event.exitCode})`}
        </CollapsibleTrigger>
        <CollapsibleContent><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px]">{event.output}</pre></CollapsibleContent>
      </Collapsible>
    );
    default: return null;
  }
}

function Transcript({ events }: { events: PlaygroundEvent[] }) {
  const box = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, []);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <div ref={box} className="flex h-[26rem] flex-col gap-1.5 overflow-y-auto rounded-lg border bg-background/60 p-3">
      {events.length === 0 && <span className="text-sm text-muted-foreground">The agent's work will stream here.</span>}
      {events.slice(-400).map((event, i) => <Entry key={i} event={event} />)}
    </div>
  );
}

/** Tokens by kind on the Context meter block (bencho, adapted), with the estimated cost beside the total. */
function TokenMeter({ sum }: { sum: ReturnType<typeof sumTasks> }) {
  return (
    <div className="bencho bencho-flat rounded-lg border">
      <ContextMeter title="Tokens" of={`tokens · ${fmt(sum.cost, "$")}`} format={value => fmt(value, "tok")} segments={[
        { id: "input", name: "Input", value: sum.input, colour: "var(--chart-1)" },
        { id: "output", name: "Output", value: sum.output, colour: "var(--chart-2)" },
        { id: "cacheRead", name: "Cache read", value: sum.cacheRead, colour: "var(--chart-3)" },
        { id: "cacheWrite", name: "Cache write", value: sum.cacheWrite, colour: "var(--chart-5)" },
      ]} />
    </div>
  );
}

const sumTasks = (tasks: Record<string, TaskResult>) => Object.values(tasks).reduce((sum, r) => ({
  cost: sum.cost + (r.costUsd ?? 0), calls: sum.calls + (r.toolCalls ?? 0), passed: sum.passed + (r.passed ? 1 : 0),
  input: sum.input + (r.tokens?.input ?? 0), output: sum.output + (r.tokens?.output ?? 0), cacheRead: sum.cacheRead + (r.tokens?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (r.tokens?.cacheWrite ?? 0),
}), { cost: 0, calls: 0, passed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function AgentTab() {
  const store = useStore();
  const o = store.options.agent;
  const claude = store.overview?.claude;
  const tasks = store.overview?.tasks ?? [];
  const chosen = new Set(o.tasks ?? tasks.map(task => task.id));
  const model = claude?.models.find(entry => entry.id === o.model);
  return (
    <TestLayout test="agent"
      options={<>
        <Field label="Model">
          <Select value={o.model} onValueChange={value => store.setOption("agent", "model", value)}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>{claude?.models.map(entry => <SelectItem key={entry.id} value={entry.id}><span className="font-mono">{entry.id}</span><span className="text-muted-foreground">${entry.price.input}/${entry.price.output}</span></SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Effort">
          <Select value={o.effort} onValueChange={value => store.setOption("agent", "effort", value)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{claude?.efforts.map(effort => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Max turns"><NumberInput value={o.maxTurns} min={1} max={25} onChange={value => store.setOption("agent", "maxTurns", value)} /></Field>
        <Field label="Time limit"><NumberInput value={o.timeLimitMin} min={1} max={10} suffix="min" onChange={value => store.setOption("agent", "timeLimitMin", value)} /></Field>
        <Field label="Tasks" className="basis-full">
          <div className="flex flex-wrap gap-2">
            {tasks.map(task => {
              const on = chosen.has(task.id);
              return (
                <Button key={task.id} size="sm" variant={on ? "secondary" : "outline"} className={cn(!on && "text-muted-foreground")} aria-pressed={on}
                  onClick={() => { const next = new Set(chosen); if (on) next.delete(task.id); else next.add(task.id); store.setOption("agent", "tasks", tasks.map(t => t.id).filter(id => next.has(id))); }}>
                  <span className={cn("size-1.5 rounded-full", on ? "bg-success" : "bg-muted-foreground/40")} />{task.title}
                </Button>
              );
            })}
          </div>
        </Field>
        <div className="basis-full space-y-3">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {model?.fallback ? <>Refusal fallback is on for this model (<code className="font-mono">fallbacks: "default"</code>): a declined request is retried on Anthropic's recommended fallback model.</> : "No server-side refusal fallback for this model."}
              {" "}Limits apply to each task: at most {o.maxTurns} turns and {o.timeLimitMin} min.
            </span>
          </p>
          {claude && !claude.available && (
            <Alert className="border-warning/40">
              <KeyRound className="text-warning" />
              <AlertTitle>No Claude API key</AlertTitle>
              <AlertDescription>
                Add one here, or set <code className="font-mono">ANTHROPIC_API_KEY</code> (or run <code className="font-mono">ant auth login</code>) before starting the playground.
                <Button size="sm" variant="outline" className="mt-2" onClick={() => store.openSetup("claude")}>Enter a Claude API key</Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </>}
      summary={view => <AgentSummary view={view} />}
      card={(view, module) => {
        const run = view.p[module]!;
        const sum = sumTasks(run.tasks);
        const total = (view.options.tasks as string[] | undefined)?.length ?? Object.keys(run.tasks).length;
        return (
          <ProviderCard module={module} run={run}>
            <div className="grid grid-cols-3 gap-2">
              <CounterStat label="Passed" value={sum.passed} unit="count" of={total} tone={Object.keys(run.tasks).length ? (sum.passed === total ? "good" : sum.passed ? "warn" : "bad") : undefined} />
              <CounterStat label="Tool calls" value={sum.calls} unit="count" />
              <Stat label="Cost" value={fmt(sum.cost, "$")} />
            </div>
            <TokenMeter sum={sum} />
            <Transcript events={run.transcript} />
          </ProviderCard>
        );
      }}
    />
  );
}

function AgentSummary({ view }: { view: View }) {
  const store = useStore();
  const tasks = store.overview?.tasks ?? [];
  const ran = ((view.options.tasks as string[] | undefined) ?? tasks.map(task => task.id)).map(id => tasks.find(task => task.id === id) ?? { id, title: id });
  const sums = Object.fromEntries(view.providers.map(module => [module, sumTasks(view.p[module]?.tasks ?? {})]));
  const total = Object.values(sums).reduce((sum, s) => sum + s.cost, 0);
  const pass = view.providers.map(module => ({ module, value: Object.keys(view.p[module]?.tasks ?? {}).length ? sums[module]!.passed / ran.length : undefined }));
  const winner = winnerOf(pass, "higher");
  const label = (module: string) => store.provider(module)?.title ?? module;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Tasks passed" hint={`${view.options.model} at effort ${view.options.effort}`}>
          <ComparisonBars unit="%" rows={pass.map(({ module, value }) => ({ module, label: label(module), value, color: colorFor(module, store.order), winner: module === winner }))} />
        </ChartCard>
        <ChartCard title="Spent so far" hint="Estimated from token usage at list prices">
          <div className="tabular text-4xl font-semibold tracking-tight">{fmt(total, "$")}</div>
          <div className="mt-2 text-xs text-muted-foreground">{view.providers.length} provider{view.providers.length === 1 ? "" : "s"} x {ran.length} task{ran.length === 1 ? "" : "s"}</div>
        </ChartCard>
        <ChartCard title="Tokens by kind">
          <TokenBars rows={view.providers.map(module => ({ label: label(module), input: sums[module]!.input, output: sums[module]!.output, cacheRead: sums[module]!.cacheRead, cacheWrite: sums[module]!.cacheWrite }))} />
        </ChartCard>
      </div>
      <ChartCard title="Results">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Provider</TableHead><TableHead>Task</TableHead><TableHead>Result</TableHead><TableHead>Wall</TableHead>
            <TableHead>Model / sandbox</TableHead><TableHead>Turns</TableHead><TableHead>Tools</TableHead><TableHead>Tokens in / out</TableHead><TableHead>Cache r / w</TableHead><TableHead>Cost</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {view.providers.flatMap(module => ran.map(task => {
              const r = view.p[module]?.tasks[task.id];
              return (
                <TableRow key={`${module}-${task.id}`}>
                  <TableCell><span className="flex items-center gap-2"><ProviderLogo module={module} size={18} />{label(module)}</span></TableCell>
                  <TableCell>{task.title}</TableCell>
                  {!r ? <TableCell colSpan={8} className="text-muted-foreground">{view.p[module]?.status === "running" ? "pending" : "-"}</TableCell>
                    : r.error ? <><TableCell><Badge variant="destructive">fail</Badge></TableCell><TableCell className="tabular">{fmt(r.wallMs, "ms")}</TableCell><TableCell colSpan={6} className="max-w-80 truncate text-xs text-muted-foreground" title={r.error.message}><span className="font-mono">{r.error.kind}</span>: {r.error.message}</TableCell></>
                    : <>
                      <TableCell className="space-x-1">
                        <Badge variant="outline" className={r.passed ? "border-success/40 text-success" : "border-destructive/50 text-destructive"}>{r.passed ? "pass" : "fail"}</Badge>
                        {r.stop && r.stop !== "end_turn" && <span className="font-mono text-[11px] text-muted-foreground" title={r.stopMessage}>{r.stop}</span>}
                        {r.fallbackUsed && <Badge variant="outline" className="text-warning">fallback</Badge>}
                      </TableCell>
                      <TableCell className="tabular">{fmt(r.wallMs, "ms")}</TableCell>
                      <TableCell className="tabular">{fmt(r.modelMs, "ms")} / {fmt(r.toolMs, "ms")}</TableCell>
                      <TableCell className="tabular">{r.turns}</TableCell>
                      <TableCell className="tabular">{r.toolCalls}</TableCell>
                      <TableCell className="tabular">{fmt(r.tokens?.input, "tok")} / {fmt(r.tokens?.output, "tok")}</TableCell>
                      <TableCell className="tabular">{fmt(r.tokens?.cacheRead, "tok")} / {fmt(r.tokens?.cacheWrite, "tok")}</TableCell>
                      <TableCell className="tabular">{fmt(r.costUsd, "$")}</TableCell>
                    </>}
                </TableRow>
              );
            }))}
          </TableBody>
        </Table>
      </ChartCard>
    </>
  );
}
