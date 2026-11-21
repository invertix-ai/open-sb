// The playground shell: sidebar, header with the run status and theme toggle, and one tab per test.
import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/AppSidebar";
import { HistorySheet } from "@/components/HistorySheet";
import { RunStatus } from "@/components/RunStatus";
import { SetupSheet } from "@/components/SetupSheet";
import { TESTS, store, useStore } from "@/lib/store";
import { api } from "@/lib/api";
import type { RunSummary, TestId } from "@/lib/types";
import { AgentTab } from "@/tabs/AgentTab";
import { CapabilitiesTab } from "@/tabs/CapabilitiesTab";
import { LoadTab } from "@/tabs/LoadTab";
import { SpeedTab } from "@/tabs/SpeedTab";
import { StreamTab } from "@/tabs/StreamTab";
import { WorkloadsTab } from "@/tabs/WorkloadsTab";

const TABS: Record<TestId, () => React.ReactNode> = { speed: SpeedTab, stream: StreamTab, agent: AgentTab, load: LoadTab, workloads: WorkloadsTab, capabilities: CapabilitiesTab };

export function App() {
  const s = useStore();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", store.theme === "dark");
    // Deep links: #tab=load opens a tab, #run=<id> replays a run in its tab.
    const hash = new URLSearchParams(location.hash.slice(1));
    void store.loadOverview().then(async () => {
      const tab = hash.get("tab");
      if (tab && TESTS.some(test => test.id === tab)) store.setTab(tab as TestId);
      const run = hash.get("run");
      if (run && /^[a-z0-9-]+$/.test(run)) store.open(await api<RunSummary>(`/api/runs/${run}`));
    }).catch(() => undefined);
    void store.refreshHistory();
    const poll = setInterval(() => void store.pollStatus(), 2500);
    const focus = () => void store.loadOverview();
    window.addEventListener("focus", focus);
    return () => { clearInterval(poll); window.removeEventListener("focus", focus); };
  }, []);

  const available = s.overview?.providers.filter(entry => entry.available).length ?? 0;
  return (
    <TooltipProvider delayDuration={250}>
      <SidebarProvider style={{ "--sidebar-width": "18rem" } as React.CSSProperties}>
        <AppSidebar />
        <SidebarInset>
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
            <SidebarTrigger />
            <Separator orientation="vertical" className="!h-5" />
            <div className="hidden text-sm text-muted-foreground sm:block">
              <span className="tabular text-foreground">{s.overview?.providers.length ?? 17}</span> providers
              <span className="mx-2 opacity-40">/</span><span className="tabular text-foreground">{available}</span> available
              <span className="mx-2 opacity-40">/</span><span className="tabular text-foreground">{s.selectedAvailable().length}</span> selected
            </div>
            <div className="absolute left-1/2 top-[10px] hidden -translate-x-1/2 md:block"><RunStatus /></div>
            <div className="ml-auto flex items-center gap-2">
              <div className="md:hidden"><RunStatus /></div>
              <HistorySheet />
              <Button variant="ghost" size="icon" aria-label="Toggle light and dark theme" onClick={() => s.setTheme(s.theme === "dark" ? "light" : "dark")}>
                {s.theme === "dark" ? <Sun /> : <Moon />}
              </Button>
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-6">
            {s.overviewError && (
              <Alert variant="destructive" className="mb-5"><AlertTitle>Could not reach the playground server</AlertTitle><AlertDescription>{s.overviewError}</AlertDescription></Alert>
            )}
            <Tabs value={s.tab} onValueChange={value => s.setTab(value as TestId)} className="gap-5">
              <TabsList>
                {TESTS.map(test => (
                  <TabsTrigger key={test.id} value={test.id} className="gap-2 px-3">
                    {test.label}
                    {s.views[test.id]?.status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />}
                  </TabsTrigger>
                ))}
              </TabsList>
              {TESTS.map(test => { const Tab = TABS[test.id]; return <TabsContent key={test.id} value={test.id}><Tab /></TabsContent>; })}
            </Tabs>
          </main>
        </SidebarInset>
      </SidebarProvider>
      <SetupSheet />
      <Toaster theme={s.theme} position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
