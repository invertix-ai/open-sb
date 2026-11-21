// Live stream: a live lag chart across providers, a lag comparison, and per provider a terminal with the lines
// as they arrive, plus the port link and desktop viewer when the provider has them.
import { useEffect, useLayoutEffect, useRef } from "react";
import { ExternalLink, MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ComparisonBars, LagChart } from "@/components/charts";
import { CounterStat, ProviderCard } from "@/components/ProviderCard";
import { ChartCard, Field, TestLayout, Waiting } from "@/components/TestLayout";
import { colorFor, fmt, safeUrl } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { StreamLine, View } from "@/lib/types";
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

function Terminal({ lines }: { lines: StreamLine[] }) {
  const box = useRef<HTMLDivElement | null>(null);
  const shown = lines.slice(-300);
  // Opens at the newest line; afterwards it follows new lines only while the reader is at the bottom.
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, []);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div ref={box} className="h-64 overflow-y-auto rounded-lg border bg-zinc-950 p-3 font-mono text-[11.5px] leading-relaxed text-zinc-300">
      {shown.length === 0 && <span className="text-zinc-500">Waiting for output...</span>}
      {shown.map(line => (
        <div key={line.n} className="grid grid-cols-[2.25rem_1fr_auto] gap-2">
          <span className="text-right text-zinc-600">{line.n}</span>
          <span className="truncate">{lineText(line.text)}</span>
          <span className={cn("tabular", lagTone(line.lagMs) === "good" ? "text-emerald-400" : lagTone(line.lagMs) === "warn" ? "text-amber-400" : "text-rose-400")}>{fmt(line.lagMs, "ms")}</span>
        </div>
      ))}
    </div>
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
        const link = run.link && safeUrl(run.link.url), desktop = run.desktop && safeUrl(run.desktop.url);
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
            {(run.lines.length > 0 || run.status === "running") && <Terminal lines={run.lines} />}
            {(link || desktop) && (
              <div className="flex flex-wrap gap-2">
                {link && <Button asChild size="sm" variant="outline"><a href={link} target="_blank" rel="noopener noreferrer"><ExternalLink />Open port {run.link!.port}</a></Button>}
                {desktop && <Button asChild size="sm" variant="outline"><a href={desktop} target="_blank" rel="noopener noreferrer"><MonitorPlay />Open desktop</a></Button>}
              </div>
            )}
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
