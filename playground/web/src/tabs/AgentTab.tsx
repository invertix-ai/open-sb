// Agent: a Claude or OpenAI agent works through the task suite in each provider's sandboxes. Pass rate, cost so
// far and a token breakdown on top, a results grid, and per provider a live terminal of every step as it
// happens (model text, commands and their output, files written, the verify result), with the sandbox's
// desktop and the HTTP task's port 8080 embedded beside it when the provider offers them without credentials.
import { Fragment } from "react";
import { Check, FilePen, Globe, KeyRound, Loader2, MonitorPlay, ShieldAlert, Square, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ComparisonBars, TokenBars } from "@/components/charts";
import { LivePreview } from "@/components/LivePreview";
import { OutputBlock, TerminalFrame } from "@/components/LiveTerminal";
import { CounterStat, ProviderCard, Stat } from "@/components/ProviderCard";
import { ContextMeter } from "@/bencho/context-meter/ContextMeter";
import "@/bencho/context-meter/ContextMeter.css";
import { ProviderLogo } from "@/components/ProviderLogo";
import { ChartCard, Field, TestLayout } from "@/components/TestLayout";
import { colorFor, fmt } from "@/lib/format";
import { agentModels, backendOf, defaultTasks, useStore } from "@/lib/store";
import type { ModelInfo, PlaygroundEvent, ProviderRun, TaskResult, View } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NumberInput, winnerOf } from "./SpeedTab";

const priceText = (model: ModelInfo) => model.price ? `$${model.price.input}/$${model.price.output}` : "price n/a";

/** One line group in the terminal per event; a call shows its result inline, with a spinner until it returns. */
function TerminalEntry({ event, result, pending }: { event: PlaygroundEvent; result?: PlaygroundEvent; pending: boolean }) {
  const spin = <Loader2 className="size-3 shrink-0 animate-spin text-sky-400" />;
  switch (event.kind) {
    case "task_start": return (
      <div className="mt-3 border-t border-zinc-800 pt-2 text-zinc-100 first:mt-0 first:border-0 first:pt-0">
        <span className="font-semibold text-sky-300">task</span> {event.title}{event.model && <span className="text-zinc-500"> · {event.model}</span>}
      </div>
    );
    case "sandbox":
      if (event.state === "creating") return <div className="flex items-center gap-1.5 text-zinc-500">{pending ? spin : <span className="w-3" />}creating sandbox</div>;
      if (event.state === "ready") return <div className="flex items-center gap-1.5 text-zinc-500"><Check className="size-3 text-emerald-400" />sandbox ready <span className="truncate text-zinc-600">{event.id}</span><span className="ml-auto">{fmt(event.ms, "ms")}</span></div>;
      return <div className="text-zinc-600">sandbox destroyed</div>;
    case "setup": return <div className="flex items-center gap-1.5 text-zinc-400">{pending ? spin : <span className="w-3 text-zinc-600">#</span>}<span className="text-zinc-500">setup:</span> {event.label}</div>;
    case "setup_done": return (
      <div className="pl-[1.125rem]">
        <span className={cn("text-[10.5px]", event.ok ? "text-emerald-400" : "text-rose-400")}>{event.ok ? "done" : "failed"} · {fmt(event.ms, "ms")}</span>
        {!event.ok && <OutputBlock text={event.output ?? ""} lines={6} className="text-rose-300" />}
      </div>
    );
    case "turn": return <div className="mt-1 text-[10.5px] text-zinc-600">turn {event.turn} · {fmt(event.ms, "ms")} · {event.stopReason}</div>;
    case "text": return <p className="my-0.5 whitespace-pre-wrap break-words border-l-2 border-violet-500/60 pl-2.5 font-sans text-[12.5px] leading-relaxed text-zinc-100">{event.text}</p>;
    case "fallback": return <div className="text-amber-400">{event.from} declined; {event.to} continued</div>;
    case "tool_call": {
      const done = result && <span className={cn("ml-auto shrink-0 pl-2 text-[10.5px]", result.isError || (result.exitCode ?? 0) !== 0 ? "text-rose-400" : "text-emerald-400")}>
        {result.exitCode !== undefined ? `exit ${result.exitCode}` : result.isError ? "error" : "ok"} · {fmt(result.ms, "ms")}
      </span>;
      const status = done ?? (pending ? <span className="ml-auto pl-2">{spin}</span> : <span className="ml-auto pl-2 text-[10.5px] text-zinc-600">no result</span>);
      const head = event.name === "run_command"
        ? <div className="flex items-start gap-1.5"><span className="shrink-0 text-emerald-400">$</span><span className="min-w-0 whitespace-pre-wrap break-all text-zinc-100">{event.command ?? event.input}</span>{status}</div>
        : event.name === "write_file"
          ? <div className="flex items-start gap-1.5"><FilePen className="mt-0.5 size-3 shrink-0 text-sky-400" /><span className="min-w-0 break-all text-zinc-100">write {event.path ?? event.input}</span>{event.bytes !== undefined && <span className="shrink-0 text-zinc-500">{event.bytes} B</span>}{status}</div>
          : <div className="flex items-start gap-1.5"><span className="shrink-0 text-amber-400">?</span><span className="min-w-0 break-all">{event.name} {event.input}</span>{status}</div>;
      return (
        <div className="mt-1">
          {head}
          {event.cwd && <div className="pl-3.5 text-[10.5px] text-zinc-600">in {event.cwd}</div>}
          {result && (result.exitCode !== undefined
            ? <><OutputBlock text={result.stdout ?? ""} /><OutputBlock text={result.stderr ?? ""} className="text-rose-300" /></>
            : result.isError && <OutputBlock text={result.content ?? ""} className="text-amber-300" />)}
        </div>
      );
    }
    case "tool_result": return <OutputBlock text={event.content ?? ""} className={event.isError ? "text-amber-300" : undefined} />;
    case "stop": return event.reason === "end_turn"
      ? <div className="mt-1 text-zinc-500">agent finished</div>
      : <div className="mt-1 flex items-center gap-1.5 text-amber-400"><Square className="size-3 fill-current" />stopped: {event.reason}{event.message ? ` (${event.message})` : ""}</div>;
    case "verify_start": return <div className="mt-1.5 flex items-center gap-1.5 text-zinc-400">{pending ? spin : <span className="w-3" />}running the verify command</div>;
    case "verify": return (
      <div className="mt-0.5">
        <div className={cn("flex items-center gap-1.5 font-semibold", event.passed ? "text-emerald-400" : "text-rose-400")}>
          {event.passed ? <Check className="size-3.5" /> : <X className="size-3.5" />}verify {event.passed ? "passed" : `failed (exit ${event.exitCode})`}
          {event.ms !== undefined && <span className="font-normal text-zinc-600">{fmt(event.ms, "ms")}</span>}
        </div>
        <OutputBlock text={event.output ?? ""} lines={6} className="text-zinc-400" />
      </div>
    );
    default: return null;
  }
}

function AgentTerminal({ run, title }: { run: ProviderRun; title: string }) {
  const events = run.transcript.slice(-500);
  const results = new Map(events.filter(event => event.kind === "tool_result").map(event => [event.id, event]));
  const calls = new Set(events.filter(event => event.kind === "tool_call").map(event => event.id));
  const running = run.status === "running" || run.status === "queued";
  const last = events.at(-1);
  const commands = events.filter(event => event.kind === "tool_call").length;
  return (
    <TerminalFrame title={title} live={running} meta={`${commands} call${commands === 1 ? "" : "s"}`} changeKey={`${run.transcript.length}:${results.size}`}
      className="h-[30rem]" empty="The agent's work will stream here as it happens.">
      {events.length > 0 ? events.map((event, i) => event.kind === "tool_result" && calls.has(event.id) ? null : (
        <Fragment key={i}>
          <TerminalEntry event={event} result={event.kind === "tool_call" ? results.get(event.id) : undefined}
            pending={running && (event.kind === "tool_call" || event === last)} />
        </Fragment>
      )) : null}
    </TerminalFrame>
  );
}

/** Tokens by kind on the Context meter block (bencho, adapted), with the estimated cost beside the total. */
function TokenMeter({ sum }: { sum: ReturnType<typeof sumTasks> }) {
  return (
    <div className="bencho bencho-flat rounded-lg border">
      <ContextMeter title="Tokens" of={`tokens · ${sum.costUnknown ? "cost n/a" : fmt(sum.cost, "$")}`} format={value => fmt(value, "tok")} segments={[
        { id: "input", name: "Input", value: sum.input, colour: "var(--chart-1)" },
        { id: "output", name: "Output", value: sum.output, colour: "var(--chart-2)" },
        { id: "cacheRead", name: "Cache read", value: sum.cacheRead, colour: "var(--chart-3)" },
        { id: "cacheWrite", name: "Cache write", value: sum.cacheWrite, colour: "var(--chart-5)" },
      ]} />
    </div>
  );
}

const sumTasks = (tasks: Record<string, TaskResult>) => Object.values(tasks).reduce((sum, r) => ({
  cost: sum.cost + (r.costUsd ?? 0), costUnknown: sum.costUnknown || r.costUsd === null, calls: sum.calls + (r.toolCalls ?? 0), passed: sum.passed + (r.passed ? 1 : 0),
  input: sum.input + (r.tokens?.input ?? 0), output: sum.output + (r.tokens?.output ?? 0), cacheRead: sum.cacheRead + (r.tokens?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (r.tokens?.cacheWrite ?? 0),
}), { cost: 0, costUnknown: false, calls: 0, passed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function AgentTab() {
  const store = useStore();
  const o = store.options.agent;
  const overview = store.overview;
  const tasks = overview?.tasks ?? [];
  const chosen = new Set(o.tasks ?? defaultTasks(overview));
  const models = agentModels(overview);
  const model = models.find(entry => entry.id === o.model);
  const backend = backendOf(overview, o.model);
  const keyMissing = overview && (backend === "openai" ? !overview.openai?.available : !overview.claude.available);
  const group = (label: string, entries: typeof models) => entries.length > 0 && (
    <SelectGroup>
      <SelectLabel>{label}</SelectLabel>
      {entries.map(entry => (
        <SelectItem key={entry.id} value={entry.id}>
          <span className="font-mono">{entry.id}</span><span className="text-muted-foreground">{priceText(entry)}</span>
        </SelectItem>
      ))}
    </SelectGroup>
  );
  return (
    <TestLayout test="agent"
      options={<>
        <Field label="Model">
          <Select value={o.model} onValueChange={value => store.setOption("agent", "model", value)}>
            <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              {group(`Claude${overview?.claude.available ? "" : " (no key)"}`, models.filter(entry => entry.backend === "claude"))}
              <SelectSeparator />
              {group(`OpenAI${overview?.openai?.available ? "" : " (no key)"}`, models.filter(entry => entry.backend === "openai"))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Effort" hint={backend === "openai" ? "Sent as reasoning effort" : undefined}>
          <Select value={o.effort} onValueChange={value => store.setOption("agent", "effort", value)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{overview?.claude.efforts.map(effort => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectContent>
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
                  {task.heavy && <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-warning" title="Installs a large toolchain: slow, and not selected by default">heavy</Badge>}
                </Button>
              );
            })}
          </div>
        </Field>
        <div className="basis-full space-y-3">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {backend === "openai"
                ? <>Runs on OpenAI's Responses API with strict function tools.{model && !model.price && " No price is on record for this model: tokens are counted, cost shows as n/a."}</>
                : model?.fallback ? <>Refusal fallback is on for this model (<code className="font-mono">fallbacks: "default"</code>): a declined request is retried on Anthropic's recommended fallback model.</> : "No server-side refusal fallback for this model."}
              {" "}The task's verify command judges every run. Limits apply to each task: at most {o.maxTurns} turns and {o.timeLimitMin} min.
            </span>
          </p>
          {keyMissing && (backend === "openai" ? (
            <Alert className="border-warning/40">
              <KeyRound className="text-warning" />
              <AlertTitle>No OpenAI API key</AlertTitle>
              <AlertDescription>
                Add one here, or set <code className="font-mono">OPENAI_API_KEY</code> before starting the playground.
                <Button size="sm" variant="outline" className="mt-2" onClick={() => store.openSetup("openai")}>Enter an OpenAI API key</Button>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="border-warning/40">
              <KeyRound className="text-warning" />
              <AlertTitle>No Claude API key</AlertTitle>
              <AlertDescription>
                Add one here, or set <code className="font-mono">ANTHROPIC_API_KEY</code> (or run <code className="font-mono">ant auth login</code>) before starting the playground.
                <Button size="sm" variant="outline" className="mt-2" onClick={() => store.openSetup("claude")}>Enter a Claude API key</Button>
              </AlertDescription>
            </Alert>
          ))}
        </div>
      </>}
      summary={view => <AgentSummary view={view} />}
      card={(view, module) => {
        const run = view.p[module]!;
        const sum = sumTasks(run.tasks);
        const total = (view.options.tasks as string[] | undefined)?.length ?? Object.keys(run.tasks).length;
        // The views belong to the current task's sandbox, which is destroyed when the task ends.
        const current = run.transcript.findLast(event => event.kind === "task_start")?.task as string | undefined;
        const open = (task?: string) => run.status === "running" && task === current && !run.tasks[current ?? ""];
        return (
          <ProviderCard module={module} run={run}>
            <div className="grid grid-cols-3 gap-2">
              <CounterStat label="Passed" value={sum.passed} unit="count" of={total} tone={Object.keys(run.tasks).length ? (sum.passed === total ? "good" : sum.passed ? "warn" : "bad") : undefined} />
              <CounterStat label="Tool calls" value={sum.calls} unit="count" />
              <Stat label="Cost" value={sum.costUnknown ? "n/a" : fmt(sum.cost, "$")} hint={sum.costUnknown ? "No price on record for this model" : undefined} />
            </div>
            <TokenMeter sum={sum} />
            <AgentTerminal run={run} title={`${view.options.model as string} @ ${store.provider(module)?.title ?? module}`} />
            {run.desktop && <LivePreview title="Desktop" icon={<MonitorPlay />} url={run.desktop.url} live={open(run.desktop.task)} />}
            {run.link && <LivePreview title={`Port ${run.link.port}`} icon={<Globe />} url={run.link.url} live={open(run.link.task)} />}
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
  const unknown = Object.values(sums).some(s => s.costUnknown);
  const pass = view.providers.map(module => ({ module, value: Object.keys(view.p[module]?.tasks ?? {}).length ? sums[module]!.passed / ran.length : undefined }));
  const winner = winnerOf(pass, "higher");
  const label = (module: string) => store.provider(module)?.title ?? module;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Tasks passed" hint={`${view.options.model} at effort ${view.options.effort}`}>
          <ComparisonBars unit="%" rows={pass.map(({ module, value }) => ({ module, label: label(module), value, color: colorFor(module, store.order), winner: module === winner }))} />
        </ChartCard>
        <ChartCard title="Spent so far" hint={unknown ? "No price on record for this model: tokens only" : "Estimated from token usage at list prices"}>
          <div className="tabular text-4xl font-semibold tracking-tight">{unknown ? "n/a" : fmt(total, "$")}</div>
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
                      <TableCell className="tabular">{r.costUsd === null ? "n/a" : fmt(r.costUsd, "$")}</TableCell>
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
