// The playground's charts, all shadcn charts on Recharts: provider comparison bars (with a p95 bar when there
// is one), a latency histogram, a live lag line chart and a stacked token breakdown.
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmt } from "@/lib/format";
import type { Bin } from "@/lib/types";

export interface ComparisonRow { module: string; label: string; value: number | null | undefined; p95?: number | null; color: string; winner?: boolean }

/** The same array while the content is the same, so a re-render does not replay the chart's animation (Recharts
 * hides value labels while it animates). */
function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}

export function ComparisonBars({ rows, unit }: { rows: ComparisonRow[]; unit: string }) {
  const data = useStable(rows.map(row => ({ ...row, value: Number.isFinite(row.value) ? row.value : null, p95: Number.isFinite(row.p95) ? row.p95 : null })));
  const hasP95 = data.some(row => row.p95 !== null);
  const config = { value: { label: hasP95 ? "p50" : "value" }, p95: { label: "p95" } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: Math.max(64, rows.length * (hasP95 ? 46 : 34) + 12) }}>
      <BarChart data={data} layout="vertical" margin={{ left: 4, right: hasP95 ? 118 : 84, top: 2, bottom: 2 }} barGap={2}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <YAxis dataKey="label" type="category" width={104} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
        <XAxis type="number" hide domain={[0, "dataMax"]} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={(value, name) => <span className="tabular">{name === "p95" ? "p95 " : hasP95 ? "p50 " : ""}{fmt(Number(value), unit)}</span>} />} />
        <Bar dataKey="value" radius={4} barSize={hasP95 ? 14 : 16}>
          {data.map(row => <Cell key={row.module} fill={row.color} fillOpacity={row.winner || rows.length === 1 ? 1 : 0.75} />)}
          <LabelList dataKey="value" position="right" className="fill-foreground tabular" fontSize={11} formatter={(value: unknown) => (value === null ? "" : fmt(Number(value), unit))} />
        </Bar>
        {hasP95 && (
          <Bar dataKey="p95" radius={4} barSize={8}>
            {data.map(row => <Cell key={row.module} fill={row.color} fillOpacity={0.35} />)}
            <LabelList dataKey="p95" position="right" className="fill-muted-foreground tabular" fontSize={10} formatter={(value: unknown) => (value === null ? "" : `p95 ${fmt(Number(value), unit)}`)} />
          </Bar>
        )}
      </BarChart>
    </ChartContainer>
  );
}

export function Histogram({ bins, color, unit = "ms" }: { bins: Bin[]; color: string; unit?: string }) {
  const data = useStable((bins ?? []).map(bin => ({ range: `${fmt(bin.from, unit)} to ${fmt(bin.to, unit)}`, tick: fmt(bin.from, unit), count: bin.count })));
  if (!bins?.length) return <div className="flex h-28 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">No samples yet</div>;
  const config = { count: { label: "Sandboxes", color } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-auto h-32 w-full">
      <BarChart data={data} margin={{ left: 0, right: 0, top: 14, bottom: 0 }} barCategoryGap={2}>
        <XAxis dataKey="tick" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={18} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelKey="range" nameKey="count" />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={3}>
          <LabelList dataKey="count" position="top" fontSize={10} className="fill-muted-foreground" formatter={(value: unknown) => (Number(value) ? String(value) : "")} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/** Lag per line, one line per provider. `series` maps a module to its lags in line order. */
export function LagChart({ series, labels, colors }: { series: Record<string, { n: number; lagMs: number }[]>; labels: Record<string, string>; colors: Record<string, string> }) {
  const modules = Object.keys(series);
  const byLine = new Map<number, Record<string, number>>();
  for (const module of modules) for (const point of series[module]!) {
    const row = byLine.get(point.n) ?? { n: point.n };
    row[module] = point.lagMs;
    byLine.set(point.n, row);
  }
  const data = [...byLine.values()].sort((a, b) => a.n! - b.n!);
  const config = Object.fromEntries(modules.map(module => [module, { label: labels[module], color: colors[module] }])) satisfies ChartConfig;
  if (!data.length) return <div className="flex h-56 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">Lines will appear here as they arrive</div>;
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="n" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
        <YAxis tickLine={false} axisLine={false} width={52} tick={{ fontSize: 11 }} tickFormatter={value => fmt(Number(value), "ms")} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => `line ${payload?.[0]?.payload?.n ?? ""}`} formatter={(value, name) => <span className="flex w-full justify-between gap-3"><span className="text-muted-foreground">{labels[String(name)] ?? name}</span><span className="tabular">{fmt(Number(value), "ms")}</span></span>} />} />
        {modules.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {modules.map(module => <Line key={module} dataKey={module} type="linear" stroke={`var(--color-${module})`} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />)}
      </LineChart>
    </ChartContainer>
  );
}

const TOKEN_KINDS = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" } as const;

export function TokenBars({ rows: given }: { rows: { label: string; input: number; output: number; cacheRead: number; cacheWrite: number }[] }) {
  const rows = useStable(given);
  const config = {
    input: { label: TOKEN_KINDS.input, color: "var(--chart-1)" },
    output: { label: TOKEN_KINDS.output, color: "var(--chart-2)" },
    cacheRead: { label: TOKEN_KINDS.cacheRead, color: "var(--chart-3)" },
    cacheWrite: { label: TOKEN_KINDS.cacheWrite, color: "var(--chart-5)" },
  } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: Math.max(90, rows.length * 34 + 50) }}>
      <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 12, top: 0, bottom: 0 }}>
        <YAxis dataKey="label" type="category" width={104} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
        <XAxis type="number" hide />
        <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={(value, name) => <span className="flex w-full justify-between gap-3"><span className="text-muted-foreground">{TOKEN_KINDS[name as keyof typeof TOKEN_KINDS]}</span><span className="tabular">{fmt(Number(value), "tok")}</span></span>} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {(Object.keys(TOKEN_KINDS) as (keyof typeof TOKEN_KINDS)[]).map((key, i, all) => (
          <Bar key={key} dataKey={key} stackId="tokens" fill={`var(--color-${key})`} barSize={16}
            radius={i === 0 ? [4, 0, 0, 4] : i === all.length - 1 ? [0, 4, 4, 0] : 0} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
