// Workloads: what agents rely on, checked without a model. Section and size pickers on top; a results matrix
// (provider by section) and file throughput charts across providers; per provider the section verdicts and a
// live terminal of every step as it runs.
import { Check, Info, Loader2, Minus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ComparisonBars } from "@/components/charts";
import { TerminalFrame } from "@/components/LiveTerminal";
import { ProviderCard } from "@/components/ProviderCard";
import { ProviderLogo } from "@/components/ProviderLogo";
import { ChartCard, Field, TestLayout } from "@/components/TestLayout";
import { colorFor, fmt } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { PlaygroundEvent, ProviderRun, SectionResult, View, WorkloadSection } from "@/lib/types";
import { cn } from "@/lib/utils";

const SECTIONS: { id: WorkloadSection; label: string; blurb: string; needs?: string }[] = [
  { id: "files", label: "Files", blurb: "Write and read back random files, sha256 compared inside and outside, MB/s each way." },
  { id: "persistence", label: "Persistence", blurb: "A file and a background counter across pause and resume.", needs: "pause" },
  { id: "fork", label: "Fork", blurb: "Snapshot a sandbox with a marker, start forks from it in parallel, check the marker.", needs: "snapshot" },
  { id: "isolation", label: "Isolation", blurb: "Outbound internet, reaching this machine, secrets in the environment, root or not. Reported, not judged." },
];
const LABEL = Object.fromEntries(SECTIONS.map(section => [section.id, section.label])) as Record<WorkloadSection, string>;

const VERDICT = {
  pass: { text: "pass", className: "border-success/40 text-success" },
  fail: { text: "fail", className: "border-destructive/50 text-destructive" },
  info: { text: "info", className: "border-sidebar-primary/40 text-sidebar-primary" },
  skip: { text: "skipped", className: "text-muted-foreground" },
} as const;

export function VerdictBadge({ result, running }: { result?: SectionResult; running?: boolean }) {
  if (!result) return running ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <Minus className="size-3 text-muted-foreground/40" />;
  return <Badge variant="outline" className={cn("h-5 font-normal", VERDICT[result.verdict].className)}>{VERDICT[result.verdict].text}</Badge>;
}

const TERM_VERDICT = { pass: "text-emerald-400", fail: "text-rose-400", info: "text-sky-300", skip: "text-zinc-500" } as const;

function WorkloadTerminal({ run, title }: { run: ProviderRun; title: string }) {
  const events = run.transcript.slice(-600);
  const done = new Map(events.filter(event => event.kind === "step_done").map(event => [event.id, event]));
  const running = run.status === "running" || run.status === "queued";
  return (
    <TerminalFrame title={title} live={running} changeKey={`${run.transcript.length}`} className="h-[26rem]" empty="Each step will stream here as it runs.">
      {events.length > 0 ? events.map((event, i) => <WorkloadLine key={i} event={event} done={event.kind === "step" ? done.get(event.id) : undefined} running={running} />) : null}
    </TerminalFrame>
  );
}

function WorkloadLine({ event, done, running }: { event: PlaygroundEvent; done?: PlaygroundEvent; running: boolean }) {
  switch (event.kind) {
    case "section": return <div className="mt-3 border-t border-zinc-800 pt-2 font-semibold text-sky-300 first:mt-0 first:border-0 first:pt-0">{event.title}</div>;
    case "step": {
      const icon = !done ? (running ? <Loader2 className="size-3 shrink-0 animate-spin text-sky-400" /> : <Minus className="size-3 shrink-0 text-zinc-600" />)
        : done.ok === true ? <Check className="size-3 shrink-0 text-emerald-400" />
        : done.ok === false ? <X className="size-3 shrink-0 text-rose-400" />
        : <Info className="size-3 shrink-0 text-sky-300" />;
      return (
        <div className="flex items-start gap-1.5">
          <span className="mt-[3px]">{icon}</span>
          <span className="min-w-0 flex-1 break-words">
            <span className="text-zinc-200">{event.text}</span>
            {done?.detail && <span className={cn("ml-2", done.ok === false ? "text-rose-300" : "text-zinc-500")}>{done.detail}</span>}
          </span>
          {done && <span className="shrink-0 pl-2 text-[10.5px] text-zinc-600">{fmt(done.ms, "ms")}</span>}
        </div>
      );
    }
    case "result": return (
      <div className={cn("mb-1 mt-1 font-semibold", TERM_VERDICT[event.verdict as keyof typeof TERM_VERDICT])}>
        {String(event.verdict).toUpperCase()} <span className="font-normal text-zinc-300">{event.summary}</span>
      </div>
    );
    default: return null;
  }
}

/** Throughput at the largest size a provider moved correctly. */
function throughput(result: SectionResult | undefined, key: "writeMbps" | "readMbps") {
  const rows = (result?.data?.sizes ?? []) as { mib: number; writeMbps?: number; readMbps?: number; readOk?: boolean }[];
  const good = rows.filter(row => row[key] !== undefined && (key === "writeMbps" || row.readOk));
  return good.at(-1)?.[key];
}

export function WorkloadsTab() {
  const store = useStore();
  const o = store.options.workloads;
  const sizes = store.overview?.workloads?.sizes ?? [1, 10, 50];
  const toggle = (key: "sections" | "sizes", value: string | number, all: (string | number)[]) => {
    const current = new Set<string | number>(o[key]);
    if (current.has(value)) current.delete(value); else current.add(value);
    store.setOption("workloads", key, all.filter(entry => current.has(entry)));
  };
  return (
    <TestLayout test="workloads"
      options={<>
        <Field label="Sections" className="basis-full">
          <div className="flex flex-wrap gap-2">
            {SECTIONS.map(section => {
              const on = o.sections.includes(section.id);
              return (
                <Button key={section.id} size="sm" variant={on ? "secondary" : "outline"} className={cn(!on && "text-muted-foreground")} aria-pressed={on} title={section.blurb}
                  onClick={() => toggle("sections", section.id, SECTIONS.map(entry => entry.id))}>
                  <span className={cn("size-1.5 rounded-full", on ? "bg-success" : "bg-muted-foreground/40")} />{section.label}
                  {section.needs && <span className="text-[10.5px] text-muted-foreground">needs {section.needs}</span>}
                </Button>
              );
            })}
          </div>
        </Field>
        {o.sections.includes("files") && (
          <Field label="File sizes">
            <div className="flex gap-1.5">
              {sizes.map(size => {
                const on = o.sizes.includes(size);
                return <Button key={size} size="sm" variant={on ? "secondary" : "outline"} className={cn("tabular", !on && "text-muted-foreground")} aria-pressed={on} onClick={() => toggle("sizes", size, sizes)}>{size} MiB</Button>;
              })}
            </div>
          </Field>
        )}
        {o.sections.includes("fork") && (
          <Field label={`Forks from the snapshot: ${o.forks}`} className="w-64" hint={`${o.forks} sandboxes at once per provider${o.forks > 2 ? "; asks before starting on cloud providers" : ""}`}>
            <Slider value={[o.forks]} min={1} max={store.overview?.limits.maxForks ?? 5} step={1} onValueChange={([value]) => store.setOption("workloads", "forks", value)} className="py-2" />
          </Field>
        )}
        <ul className="basis-full space-y-1 text-xs text-muted-foreground">
          {SECTIONS.filter(section => o.sections.includes(section.id)).map(section => <li key={section.id}><b className="font-medium text-foreground">{section.label}:</b> {section.blurb}</li>)}
        </ul>
      </>}
      summary={view => <WorkloadsSummary view={view} />}
      card={(view, module) => {
        const run = view.p[module]!;
        const chosen = (view.options.sections as WorkloadSection[] | undefined) ?? SECTIONS.map(section => section.id);
        return (
          <ProviderCard module={module} run={run}>
            <div className="divide-y rounded-lg border">
              {chosen.map(section => {
                const result = run.sections[section];
                return (
                  <div key={section} className="flex items-start gap-3 px-3 py-2">
                    <span className="w-24 shrink-0 text-xs font-medium">{LABEL[section]}</span>
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">{result?.summary ?? (run.status === "running" ? "waiting" : "-")}</span>
                    <VerdictBadge result={result} running={run.status === "running"} />
                  </div>
                );
              })}
            </div>
            <WorkloadTerminal run={run} title={`workloads @ ${store.provider(module)?.title ?? module}`} />
          </ProviderCard>
        );
      }}
    />
  );
}

function WorkloadsSummary({ view }: { view: View }) {
  const store = useStore();
  const chosen = (view.options.sections as WorkloadSection[] | undefined) ?? SECTIONS.map(section => section.id);
  const label = (module: string) => store.provider(module)?.title ?? module;
  const bars = (key: "writeMbps" | "readMbps") => view.providers.map(module => ({
    module, label: label(module), value: throughput(view.p[module]?.sections.files, key), color: colorFor(module, store.order), winner: false,
  }));
  const forks = view.providers.map(module => ({ module, label: label(module), value: view.p[module]?.sections.fork?.data?.forkMs?.p50 ?? undefined, color: colorFor(module, store.order), winner: false }));
  return (
    <>
      <ChartCard title="Results" hint="Hover a summary for all of it">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Provider</TableHead>
            {chosen.map(section => <TableHead key={section}>{LABEL[section]}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>
            {view.providers.map(module => (
              <TableRow key={module}>
                <TableCell><span className="flex items-center gap-2"><ProviderLogo module={module} size={18} />{label(module)}</span></TableCell>
                {chosen.map(section => {
                  const result = view.p[module]?.sections[section];
                  return (
                    <TableCell key={section} className="max-w-72 align-top">
                      <div className="flex flex-col gap-1">
                        <VerdictBadge result={result} running={view.p[module]?.status === "running"} />
                        {result && <span className="line-clamp-2 whitespace-normal text-xs text-muted-foreground" title={result.summary}>{result.summary}</span>}
                      </div>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ChartCard>
      {(chosen.includes("files") || chosen.includes("fork")) && (
        <div className="grid gap-4 lg:grid-cols-3">
          {chosen.includes("files") && <ChartCard title="Write throughput" hint="Largest size written; higher is better"><ComparisonBars unit="MB/s" rows={bars("writeMbps")} /></ChartCard>}
          {chosen.includes("files") && <ChartCard title="Read throughput" hint="Largest size read back intact; higher is better"><ComparisonBars unit="MB/s" rows={bars("readMbps")} /></ChartCard>}
          {chosen.includes("fork") && <ChartCard title="Fork ready (p50)" hint="Create from the snapshot to marker read; lower is better"><ComparisonBars unit="ms" rows={forks} /></ChartCard>}
        </div>
      )}
    </>
  );
}
