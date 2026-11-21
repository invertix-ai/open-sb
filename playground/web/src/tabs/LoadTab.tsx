// Load: N sandboxes at once per provider. Success rate and latency comparisons on top; per provider the
// errors grouped by SandboxError kind, two histograms and the p50 / p95 / max table.
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ComparisonBars, Histogram } from "@/components/charts";
import { CounterStat, ProviderCard } from "@/components/ProviderCard";
import { ChartCard, Field, TestLayout, Waiting } from "@/components/TestLayout";
import { colorFor, fmt } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { LoadMetric, View } from "@/lib/types";
import { winnerOf } from "./SpeedTab";

export function LoadTab() {
  const store = useStore();
  const n = store.options.load.n;
  const providers = Math.max(1, store.selectedAvailable().length);
  return (
    <TestLayout test="load"
      options={<>
        <Field label={`Sandboxes per provider: ${n}`} className="w-72">
          <Slider value={[n]} min={1} max={store.overview?.limits.maxLoad ?? 20} step={1} onValueChange={([value]) => store.setOption("load", "n", value)} className="py-2" />
        </Field>
        <Alert className="max-w-2xl flex-1 border-warning/40">
          <TriangleAlert className="text-warning" />
          <AlertDescription>This creates <b className="tabular text-foreground">{n}</b> real sandboxes per provider (<span className="tabular">{n * providers}</span> in total) at the same time. Cloud providers bill for them; all are destroyed at the end.</AlertDescription>
        </Alert>
      </>}
      summary={view => <LoadSummary view={view} />}
      card={(view, module) => {
        const run = view.p[module]!;
        const load = run.load;
        const color = colorFor(module, store.order);
        return (
          <ProviderCard module={module} run={run}>
            {!load && run.status === "running" && <Waiting />}
            {load && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <CounterStat label="Success" value={load.done ? load.ok / load.done : null} unit="%" tone={load.done ? (load.ok === load.done ? "good" : load.ok ? "warn" : "bad") : undefined} />
                  <CounterStat label="Done" value={load.done} unit="count" of={load.n} />
                  <CounterStat label="Failed" value={load.done - load.ok} unit="count" tone={load.done - load.ok ? "bad" : undefined} />
                </div>
                <Progress value={(load.done / load.n) * 100} />
                {Object.keys(load.errors).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">{Object.entries(load.errors).map(([kind, count]) => <Badge key={kind} variant="outline" className="border-destructive/50 font-mono text-destructive">{kind} x {count}</Badge>)}</div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div><div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">End to end</div><Histogram bins={load.totalHistogram} color={color} /></div>
                  <div><div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Create to ready</div><Histogram bins={load.readyHistogram} color={color} /></div>
                </div>
                <Table>
                  <TableHeader><TableRow><TableHead /><TableHead>p50</TableHead><TableHead>p95</TableHead><TableHead>max</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {([["Ready", load.ready], ["End to end", load.total]] as const).map(([label, s]) => (
                      <TableRow key={label}><TableCell className="text-muted-foreground">{label}</TableCell><TableCell className="tabular">{fmt(s.p50, "ms")}</TableCell><TableCell className="tabular">{fmt(s.p95, "ms")}</TableCell><TableCell className="tabular">{fmt(s.max, "ms")}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </ProviderCard>
        );
      }}
    />
  );
}

function LoadSummary({ view }: { view: View }) {
  const store = useStore();
  const rows = (pick: (load: LoadMetric | undefined) => number | null | undefined, p95?: (load: LoadMetric | undefined) => number | null | undefined, better = "lower") => {
    const values = view.providers.map(module => ({ module, value: pick(view.p[module]?.load) }));
    const winner = winnerOf(values, better);
    return values.map(({ module, value }) => ({ module, label: store.provider(module)?.title ?? module, value, p95: p95?.(view.p[module]?.load), color: colorFor(module, store.order), winner: module === winner }));
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <ChartCard title="Success rate" hint="higher is better"><ComparisonBars unit="%" rows={rows(load => (load?.done ? load.ok / load.n : undefined), undefined, "higher")} /></ChartCard>
      <ChartCard title="Create to ready" hint="p50 and p95"><ComparisonBars unit="ms" rows={rows(load => load?.ready.p50, load => load?.ready.p95)} /></ChartCard>
      <ChartCard title="End to end" hint="create, wait, exec, destroy"><ComparisonBars unit="ms" rows={rows(load => load?.total.p50, load => load?.total.p95)} /></ChartCard>
    </div>
  );
}
