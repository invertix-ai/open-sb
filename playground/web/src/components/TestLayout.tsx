// The frame every test tab shares: an options card with Run and Cancel, comparison charts across providers,
// then one card per provider in a responsive grid. Empty and loading states live here too.
import type { ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { RunControls } from "@/components/RunControls";
import { TESTS, useStore } from "@/lib/store";
import type { TestId, View } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function ChartCard({ title, hint, children, className }: { title: ReactNode; hint?: string; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-3 py-4", className)}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        {hint && <CardDescription className="text-xs">{hint}</CardDescription>}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

export function TestLayout({ test, options, summary, card }: {
  test: TestId;
  options: ReactNode;
  summary?: (view: View) => ReactNode;
  card: (view: View, module: string) => ReactNode;
}) {
  const store = useStore();
  const view = store.views[test];
  const meta = TESTS.find(entry => entry.id === test)!;
  return (
    <div className="flex flex-col gap-5">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{meta.label}</CardTitle>
          <CardDescription>{meta.blurb}</CardDescription>
          <CardAction><RunControls test={test} /></CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-x-6 gap-y-4">{options}</CardContent>
      </Card>

      {!view && <Empty label={meta.label} />}
      {view && (
        <>
          {view.error && <Alert variant="destructive"><AlertTitle className="font-mono text-xs uppercase">{view.error.kind}</AlertTitle><AlertDescription>{view.error.message}</AlertDescription></Alert>}
          {summary?.(view)}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-4">
            {view.providers.map(module => <div key={module} className="min-w-0">{card(view, module)}</div>)}
          </div>
        </>
      )}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted"><FlaskConical className="size-5 text-muted-foreground" /></div>
      <div className="font-medium">No {label.toLowerCase()} run yet</div>
      <p className="max-w-sm text-sm text-muted-foreground">Switch on providers in the sidebar and press Run. Each provider gets its own card, with comparison charts on top.</p>
    </div>
  );
}

/** Placeholder blocks while a provider has nothing to show yet. */
export function Waiting({ lines = 3 }: { lines?: number }) {
  return <div className="space-y-2">{Array.from({ length: lines }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
}
