// Past runs kept in the server's memory: open one to replay it in its tab, or export it with all its events.
import { Download, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ProviderLogo } from "@/components/ProviderLogo";
import { api } from "@/lib/api";
import { TESTS, useStore } from "@/lib/store";
import type { RunSummary } from "@/lib/types";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function HistorySheet() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={next => { setOpen(next); if (next) void store.refreshHistory(); }}>
      <SheetTrigger asChild><Button variant="outline" size="sm"><History />History</Button></SheetTrigger>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Run history</SheetTitle>
          <SheetDescription>Kept in memory until the server stops. Export saves a run with all its events as JSON.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          {store.history.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No runs yet.</p>}
          {store.history.map(run => (
            <div key={run.id} className="rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40">
              <button type="button" className="w-full space-y-2 text-left" onClick={async () => {
                try { store.open(await api<RunSummary>(`/api/runs/${encodeURIComponent(run.id)}`)); setOpen(false); } catch (error) { toast.error((error as Error).message); }
              }}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{TESTS.find(test => test.id === run.test)?.label ?? run.test}</span>
                  <Badge variant="outline" className={cn("font-normal", run.status === "done" && "text-success", run.status === "failed" && "text-destructive", run.status === "running" && "text-sidebar-primary")}>{run.status}</Badge>
                </div>
                <div className="flex gap-1">{run.providers.map(module => <ProviderLogo key={module} module={module} size={18} />)}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{new Date(run.startedAt).toLocaleString()} · {run.id}</div>
              </button>
              <Button asChild variant="ghost" size="xs" className="mt-2"><a href={`/api/runs/${encodeURIComponent(run.id)}/export`} download><Download />Export JSON</a></Button>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
