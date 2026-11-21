// Speed: comparison bars per metric (p50 and p95 for exec round trips), a results table with the best value
// per metric marked, and the measurements in each provider's card.
import { Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ComparisonBars } from "@/components/charts";
import { CounterStat, ProviderCard } from "@/components/ProviderCard";
import { ProviderLogo } from "@/components/ProviderLogo";
import { ChartCard, Field, TestLayout, Waiting } from "@/components/TestLayout";
import { colorFor, fmt } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { View } from "@/lib/types";
import { cn } from "@/lib/utils";

export const SPEED_METRICS = [
  { key: "create_ms", label: "Create to running", unit: "ms", better: "lower" },
  { key: "first_exec_ms", label: "First exec", unit: "ms", better: "lower" },
  { key: "exec_p50_ms", p95: "exec_p95_ms", label: "Exec round trip", unit: "ms", better: "lower" },
  { key: "write_mbps", label: "Write file", unit: "MB/s", better: "higher" },
  { key: "read_mbps", label: "Read file", unit: "MB/s", better: "higher" },
  { key: "pause_ms", label: "Pause", unit: "ms", better: "lower" },
  { key: "resume_ms", label: "Resume", unit: "ms", better: "lower" },
  { key: "destroy_ms", label: "Destroy", unit: "ms", better: "lower" },
] as const;

export function winnerOf(values: { module: string; value: number | undefined | null }[], better: string) {
  const finite = values.filter(entry => Number.isFinite(entry.value));
  if (finite.length < 2) return null;
  return finite.reduce((best, entry) => ((better === "higher" ? entry.value! > best.value! : entry.value! < best.value!) ? entry : best)).module;
}

export function NumberInput({ value, min, max, step = 1, onChange, suffix }: { value: number; min: number; max: number; step?: number; onChange: (value: number) => void; suffix?: string }) {
  return (
    <div className="relative">
      <Input type="number" className={cn("tabular w-28", suffix && "pr-10")} value={value} min={min} max={max} step={step}
        onChange={event => { if (event.target.value !== "") onChange(Math.min(max, Math.max(min, Number(event.target.value)))); }} />
      {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

export function SpeedTab() {
  const store = useStore();
  const o = store.options.speed;
  return (
    <TestLayout test="speed"
      options={<>
        <Field label="Exec round trips"><NumberInput value={o.rounds} min={1} max={50} onChange={value => store.setOption("speed", "rounds", value)} /></Field>
        <Field label="File size"><NumberInput value={o.fileMiB} min={1} max={16} suffix="MiB" onChange={value => store.setOption("speed", "fileMiB", value)} /></Field>
        <label className="flex h-9 items-center gap-2 text-sm"><Switch checked={o.pause} onCheckedChange={value => store.setOption("speed", "pause", value)} />Pause and resume, when supported</label>
      </>}
      summary={view => <SpeedSummary view={view} />}
      card={(view, module) => {
        const run = view.p[module]!;
        const m = run.metrics;
        const any = SPEED_METRICS.some(metric => Number.isFinite(m[metric.key]));
        return (
          <ProviderCard module={module} run={run}>
            {!any && run.status === "running" && <Waiting />}
            {any && (
              <div className="grid grid-cols-2 gap-2">
                <CounterStat label="Create" value={m.create_ms} unit="ms" />
                <CounterStat label="Exec p50" value={m.exec_p50_ms} unit="ms" hint={`p95 ${fmt(m.exec_p95_ms, "ms")}`} />
              </div>
            )}
            {any && (
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
                {SPEED_METRICS.filter(metric => Number.isFinite(m[metric.key])).map(metric => (
                  <div key={metric.key} className="contents">
                    <dt className="text-muted-foreground">{metric.label}</dt>
                    <dd className="tabular text-right">{fmt(m[metric.key], metric.unit)}{"p95" in metric && Number.isFinite(m[metric.p95]) && <span className="text-muted-foreground"> / {fmt(m[metric.p95], metric.unit)}</span>}</dd>
                  </div>
                ))}
              </dl>
            )}
          </ProviderCard>
        );
      }}
    />
  );
}

function SpeedSummary({ view }: { view: View }) {
  const store = useStore();
  const metrics = SPEED_METRICS.filter(metric => view.providers.some(module => Number.isFinite(view.p[module]?.metrics[metric.key])));
  if (!metrics.length) return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(i => <ChartCard key={i} title="Waiting for the first measurements"><Waiting lines={2} /></ChartCard>)}</div>;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {metrics.map(metric => {
          const values = view.providers.map(module => ({ module, value: view.p[module]?.metrics[metric.key] }));
          const winner = winnerOf(values, metric.better);
          return (
            <ChartCard key={metric.key} title={metric.label} hint={`${"p95" in metric ? "p50 and p95, " : ""}${metric.better} is better`}>
              <ComparisonBars unit={metric.unit} rows={values.map(({ module, value }) => ({
                module, label: store.provider(module)?.title ?? module, value, color: colorFor(module, store.order), winner: module === winner,
                p95: "p95" in metric ? view.p[module]?.metrics[metric.p95] : undefined,
              }))} />
            </ChartCard>
          );
        })}
      </div>
      <ChartCard title="Results" hint="The best value per metric is marked">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              {view.providers.map(module => <TableHead key={module}><span className="flex items-center gap-2"><ProviderLogo module={module} size={18} />{store.provider(module)?.title}</span></TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {SPEED_METRICS.map(metric => {
              const values = view.providers.map(module => ({ module, value: view.p[module]?.metrics[metric.key] }));
              const winner = winnerOf(values, metric.better);
              return (
                <TableRow key={metric.key}>
                  <TableCell className="text-muted-foreground">{metric.label}</TableCell>
                  {values.map(({ module, value }) => (
                    <TableCell key={module} className={cn("tabular", module === winner && "font-semibold text-success")}>
                      {Number.isFinite(value) ? fmt(value, metric.unit) : <span className="text-muted-foreground">-</span>}
                      {"p95" in metric && Number.isFinite(view.p[module]?.metrics[metric.p95]) && <span className="font-normal text-muted-foreground"> / {fmt(view.p[module]!.metrics[metric.p95], metric.unit)}</span>}
                      {module === winner && <Badge variant="outline" className="ml-2 gap-1 border-success/40 text-[10px] text-success"><Trophy className="size-3" />best</Badge>}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ChartCard>
    </>
  );
}
