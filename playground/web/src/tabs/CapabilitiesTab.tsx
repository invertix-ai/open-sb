// Capabilities: the declared matrix for the selected providers (all of them when none are selected), and
// quick verify results for the core checks, shown as a checklist per provider.
import { Check, Loader2, Minus, X } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CAP_LABELS } from "@/components/AppSidebar";
import { Checklist } from "@/bencho/checklist/Checklist";
import "@/bencho/checklist/Checklist.css";
import { ProviderLogo } from "@/components/ProviderLogo";
import { RunControls } from "@/components/RunControls";
import { fmt } from "@/lib/format";
import { TESTS, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const CHECK_LABELS: Record<string, string> = { create: "Create", exec: "Exec", files: "Write and read", list: "List by label", destroy: "Destroy" };

export function CapabilitiesTab() {
  const store = useStore();
  const view = store.views.capabilities;
  const meta = TESTS.find(test => test.id === "capabilities")!;
  const selected = store.selectedAvailable();
  const modules = view ? view.providers : selected.length ? selected : store.order;
  const checks = store.overview?.checks ?? Object.keys(CHECK_LABELS);
  const caps = Object.keys(CAP_LABELS);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{meta.label}</CardTitle>
          <CardDescription>Capability marks come from each provider's code. Quick verify creates one real sandbox per selected provider and checks create, exec, write and read, list by label and destroy.</CardDescription>
          <CardAction><RunControls test="capabilities" /></CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Capability matrix</CardTitle>
          <CardDescription className="text-xs">{view ? `Quick verify ${view.status}` : selected.length ? "Selected providers" : "All providers. Select some in the sidebar to narrow it down."}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                {caps.map(cap => <TableHead key={cap} className="text-center">{CAP_LABELS[cap]}</TableHead>)}
                {checks.map((check, i) => <TableHead key={check} className={cn("text-center", i === 0 && "border-l")}>{CHECK_LABELS[check]}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {modules.map(module => {
                const entry = store.provider(module);
                const run = view?.p[module];
                return (
                  <TableRow key={module}>
                    <TableCell><span className="flex items-center gap-2 font-medium"><ProviderLogo module={module} size={20} dim={!entry?.available} />{entry?.title ?? module}</span></TableCell>
                    {caps.map(cap => (
                      <TableCell key={cap} className="text-center">
                        {entry?.capabilities.includes(cap)
                          ? <span className="inline-flex size-5 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-3" strokeWidth={3} /></span>
                          : <Minus className="mx-auto size-3 text-muted-foreground/40" />}
                      </TableCell>
                    ))}
                    {checks.map((check, i) => {
                      const result = run?.checks[check];
                      return (
                        <TableCell key={check} className={cn("text-center", i === 0 && "border-l")}>
                          {result ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className={cn("inline-flex size-6 items-center justify-center rounded-md", result.ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive")}>
                                  {result.ok ? <Check className="size-3.5" strokeWidth={3} /> : <X className="size-3.5" strokeWidth={3} />}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{CHECK_LABELS[check]}: {result.ok ? fmt(result.ms, "ms") : result.message}</TooltipContent>
                            </Tooltip>
                          ) : run?.status === "running" ? <Loader2 className="mx-auto size-3.5 animate-spin text-muted-foreground" /> : <Minus className="mx-auto size-3 text-muted-foreground/40" />}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="text-muted-foreground">Providers with it</TableCell>
                {caps.map(cap => <TableCell key={cap} className="tabular text-center">{modules.filter(module => store.provider(module)?.capabilities.includes(cap)).length}</TableCell>)}
                <TableCell colSpan={checks.length} className="border-l" />
              </TableRow>
            </TableFooter>
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">Every provider also has create, get, list, destroy, exec, readFile and writeFile. Hover a result for its time or error.</p>
        </CardContent>
      </Card>

      {view && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
          {view.providers.map(module => {
            const run = view.p[module]!;
            return (
              <Card key={module} className="gap-3">
                <CardHeader className="flex items-center gap-3">
                  <ProviderLogo module={module} size={26} />
                  <CardTitle className="text-sm">{store.provider(module)?.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="bencho bencho-card -mx-2">
                    <Checklist items={checks.map(check => {
                      const result = run.checks[check];
                      return {
                        id: check, label: CHECK_LABELS[check] ?? check,
                        state: result ? (result.ok ? "done" : "failed") : run.status === "running" ? "running" : "pending",
                        detail: result ? (result.ok ? fmt(result.ms, "ms") : "failed") : undefined,
                      };
                    })} />
                  </div>
                  {Object.values(run.checks).some(result => !result.ok) && (
                    <div className="mt-3 space-y-1 text-xs text-destructive">{checks.filter(check => run.checks[check] && !run.checks[check]!.ok).map(check => <div key={check}><b>{CHECK_LABELS[check]}:</b> {run.checks[check]!.message}</div>)}</div>
                  )}
                  {run.error && <div className="mt-3 text-xs text-destructive"><span className="font-mono uppercase">{run.error.kind}</span> {run.error.message}</div>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
