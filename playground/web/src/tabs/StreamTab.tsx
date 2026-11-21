// Live stream: a live lag chart across providers, a lag comparison, and per provider a live terminal with the
// lines as they arrive (with a Follow switch), plus the port 8080 page and the desktop viewer embedded when the
// provider has them and they open without credentials.
import { Globe } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { ComparisonBars, LagChart } from "@/components/charts";
import { LivePreview } from "@/components/LivePreview";
import { LiveDesktop } from "@/components/LiveDesktop";
import { TerminalFrame } from "@/components/LiveTerminal";
import { CounterStat, ProviderCard } from "@/components/ProviderCard";
import { ChartCard, Field, TestLayout, Waiting } from "@/components/TestLayout";
import { colorFor, fmt } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { ProviderRun, StreamLine, View } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NumberInput, winnerOf } from "./SpeedTab";

const lagTone = (ms: number | undefined) => (!Number.isFinite(ms) ? undefined : ms! < 600 ? "good" : ms! < 1500 ? "warn" : "bad");

/** "12 1795230680996 line 12 of 75" becomes the sandbox's own time and the rest of the line. */
function lineText(text: string) {
  const match = /^\d+ (\d{13}) (.*)$/.exec(text);
  if (!match) return text;
  const at = new Date(Number(match[1]));
  return `${at.toTimeString().slice(0, 8)}.${String(at.getMilliseconds()).padStart(3, "0")}  ${match[2]}`;
}

function Terminal({ lines, run, title }: { lines: StreamLine[]; run: ProviderRun; title: string }) {
  const shown = lines.slice(-300);
  const last = shown.at(-1)?.n ?? 0;
  return (
    <TerminalFrame title={title} live={run.status === "running"} changeKey={last} className="h-72"
      meta={run.lag ? `${run.lag.received}/${run.lag.expected} lines` : undefined}>
      {shown.length > 0 ? shown.map(line => (
        <div key={line.n} className="grid grid-cols-[2.25rem_1fr_auto] gap-2">
          <span className="text-right text-zinc-600">{line.n}</span>
          <span className="truncate">{lineText(line.text)}</span>
          <span className={cn("tabular", lagTone(line.lagMs) === "good" ? "text-emerald-400" : lagTone(line.lagMs) === "warn" ? "text-amber-400" : "text-rose-400")}>{fmt(line.lagMs, "ms")}</span>
        </div>
      )) : null}
    </TerminalFrame>
  );
}

export function StreamTab() {
  const store = useStore();
  const o = store.options.stream;
  return (
    <TestLayout test="stream"
      options={<>
        <Field label="Duration"><NumberInput value={o.durationS} min={5} max={120} suffix="s" onChange={value => store.setOption("stream", "durationS", value)} /></Field>
        <Field label="Line every"><NumberInput value={o.intervalMs} min={50} max={2000} step={50} suffix="ms" onChange={value => store.setOption("stream", "intervalMs", value)} /></Field>
        <Field label="Poll every"><NumberInput value={o.pollMs} min={100} max={5000} step={50} suffix="ms" onChange={value => store.setOption("stream", "pollMs", value)} /></Field>
      </>}
      summary={view => <StreamSummary view={view} />}
      card={(view, module) => {
        const run = view.p[module]!;
        const lag = run.lag;
        const live = run.status === "running";
        return (
          <ProviderCard module={module} run={run}>
            {!lag && run.status === "running" && <Waiting lines={2} />}
            {lag && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <CounterStat label="Lag p50" value={lag.p50} unit="ms" tone={lagTone(lag.p50)} />
                  <CounterStat label="Lag p95" value={lag.p95} unit="ms" tone={lagTone(lag.p95)} />
                  <CounterStat label="Lines" value={lag.received} unit="count" of={lag.expected} />
                </div>
                <Progress value={(lag.received / lag.expected) * 100} />
              </>
            )}
            {(run.lines.length > 0 || run.status === "running") && <Terminal lines={run.lines} run={run} title={`tail -f stream.log @ ${store.provider(module)?.title ?? module}`} />}
            {run.desktop && <LiveDesktop key={run.desktop.sandboxId} connection={run.desktop} live={live} onReconnect={() => store.reconnectDesktop("stream", module)} />}
            {run.link && <LivePreview title={`Port ${run.link.port}`} icon={<Globe />} url={run.link.url} live={live} />}
          </ProviderCard>
        );
      }}
    />
  );
}

function StreamSummary({ view }: { view: View }) {
  const store = useStore();
  const series = Object.fromEntries(view.providers.map(module => [module, view.p[module]?.lines ?? []]));
  const labels = Object.fromEntries(view.providers.map(module => [module, store.provider(module)?.title ?? module]));
  const colors = Object.fromEntries(view.providers.map(module => [module, colorFor(module, store.order)]));
  const winner = winnerOf(view.providers.map(module => ({ module, value: view.p[module]?.lag?.p50 })), "lower");
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <ChartCard title="Delivery lag per line" hint="Time from the line's timestamp in the sandbox to its arrival here, corrected for clock offset">
        <LagChart series={series} labels={labels} colors={colors} />
      </ChartCard>
      <ChartCard title="Lag p50 and p95" hint="lower is better">
        <ComparisonBars unit="ms" rows={view.providers.map(module => ({
          module, label: labels[module]!, value: view.p[module]?.lag?.p50, p95: view.p[module]?.lag?.p95, color: colors[module]!, winner: module === winner,
        }))} />
      </ChartCard>
    </div>
  );
}
