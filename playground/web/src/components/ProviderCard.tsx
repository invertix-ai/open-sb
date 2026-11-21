// One provider's column in the results: logo, name, run status, an error box with the SandboxError kind, the
// test's own content, and the last log lines.
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderLogo } from "@/components/ProviderLogo";
import { colorFor, fmt } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { ProviderRun } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Counter } from "@/bencho/rolling-counter/Counter";
import "@/bencho/rolling-counter/Counter.css";

const KIND_HELP: Record<string, string> = {
  unavailable: "The provider is down, overloaded or unreachable.",
  not_found: "The sandbox or resource no longer exists.",
  rejected: "The provider refused the request: bad input, permission or quota.",
  timeout: "The call ran out of time.",
  cancelled: "The run was cancelled.",
};

export function StatusBadge({ status, ms }: { status: ProviderRun["status"]; ms?: number }) {
  const icon = status === "running" ? <Loader2 className="animate-spin" /> : status === "done" ? <CheckCircle2 /> : status === "failed" ? <XCircle /> : <CircleDashed />;
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal",
      status === "done" && "border-success/40 text-success", status === "failed" && "border-destructive/50 text-destructive",
      status === "running" && "border-sidebar-primary/50 text-sidebar-primary", status === "cancelled" && "border-warning/50 text-warning")}>
      {icon}{status}{ms ? <span className="tabular opacity-70">{fmt(ms, "ms")}</span> : null}
    </Badge>
  );
}

export function ProviderCard({ module, run, children, className }: { module: string; run: ProviderRun; children?: ReactNode; className?: string }) {
  const store = useStore();
  const entry = store.provider(module);
  return (
    <Card className={cn("relative gap-4 overflow-hidden", className)}>
      <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: colorFor(module, store.order) }} />
      <CardHeader className="flex items-center gap-3">
        <ProviderLogo module={module} size={32} />
        <div className="min-w-0">
          <CardTitle className="truncate">{entry?.title ?? module}</CardTitle>
          <CardDescription className="truncate text-xs">{entry?.kind}</CardDescription>
        </div>
        <CardAction className="self-center"><StatusBadge status={run.status} ms={run.ms} /></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {run.error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle className="font-mono text-xs uppercase tracking-wide">{run.error.kind}</AlertTitle>
            <AlertDescription className="break-words text-xs">
              {run.error.message}
              {KIND_HELP[run.error.kind] && <span className="mt-1 block opacity-80">{KIND_HELP[run.error.kind]}</span>}
            </AlertDescription>
          </Alert>
        )}
        {children}
        {run.logs.length > 0 && (
          <div className="space-y-0.5 border-t pt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {run.logs.slice(-5).map((log, i) => <div key={i} className={cn("break-words", log.level === "warn" && "text-warning", log.level === "error" && "text-destructive")}>{log.message}</div>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A labelled number in a card: the headline metrics. Text, for values the rolling counter cannot show. */
export function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "good" | "warn" | "bad"; hint?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("tabular text-lg font-semibold", toneClass(tone))}>{value}</div>
    </div>
  );
}

const toneClass = (tone?: "good" | "warn" | "bad") => cn(tone === "good" && "text-success", tone === "warn" && "text-warning", tone === "bad" && "text-destructive");
const TONE_VAR = { good: "var(--success)", warn: "var(--warning)", bad: "var(--destructive)" } as const;

/**
 * A headline number on the Rolling counter block (bencho, adapted): its digits roll to each new value. Times show
 * in whole milliseconds (seconds past 99,999 ms), shares as whole percent, counts as they are.
 */
export function CounterStat({ label, value, unit, tone, hint, of }: {
  label: string; value: number | null | undefined; unit: "ms" | "%" | "count"; tone?: "good" | "warn" | "bad"; hint?: string;
  /** For counts: the total after the number, as in 3/5. */
  of?: number;
}) {
  let shown: number | null = null, suffix: string | undefined, places = 5;
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    // The time unit goes in the label (tiles are narrow; "1,033" plus "ms" would not fit three across).
    if (unit === "ms") shown = value < 100_000 ? Math.round(value) : Math.round(value / 1000);
    else if (unit === "%") { shown = Math.round(value * 100); suffix = "%"; places = 3; }
    else { shown = Math.round(value); suffix = of !== undefined ? `/${of}` : undefined; places = 4; }
  }
  return (
    <div className="min-w-0 rounded-lg border bg-muted/30 px-3 pt-2 pb-1" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}{unit === "ms" && <span className="normal-case opacity-70"> · {value !== null && value !== undefined && value >= 100_000 ? "s" : "ms"}</span>}
      </div>
      {shown === null
        ? <div className="tabular h-[34px] text-lg font-semibold leading-[34px] text-muted-foreground">-</div>
        : (
          <div className="bencho bencho-flat -ml-2.5 overflow-hidden" style={tone ? { "--fill-on": TONE_VAR[tone] } as React.CSSProperties : undefined}>
            {/* Smaller digits for longer numbers, so "1,033" and "12,345" fit a tile three across. */}
            <Counter value={shown} readOnly cell={String(shown).length >= 5 ? 26 : String(shown).length === 4 ? 30 : 34} places={places} suffix={suffix} corner={8} label={label} />
          </div>
        )}
    </div>
  );
}
