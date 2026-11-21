// Run and Cancel for the current tab. Runs that spend money (the Agent test, and Load on a cloud provider)
// open a confirmation with the numbers first, confirmed by sliding.
import { useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SlideToStart } from "@/components/SlideToStart";
import { fmt } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { TestId } from "@/lib/types";

export function blockedReason(store: ReturnType<typeof useStore>, test: TestId): string {
  if (!store.overview) return "Loading";
  if (store.selectedAvailable().length === 0) return "Select at least one available provider";
  if (test === "agent" && !store.overview.claude.available) return "No Claude key";
  if (test === "agent" && store.options.agent.tasks?.length === 0) return "Pick at least one task";
  return "";
}

export function RunControls({ test }: { test: TestId }) {
  const store = useStore();
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const view = store.views[test];
  const running = view?.status === "running";
  const blocked = blockedReason(store, test);
  const providers = store.selectedAvailable();

  async function start() {
    setConfirming(false);
    setStarting(true);
    try { await store.start(test); } catch (error) { toast.error("Could not start the run", { description: (error as Error).message }); } finally { setStarting(false); }
  }

  const spends = test === "agent" || (test === "load" && providers.some(module => module !== "docker"));
  const agent = store.options.agent;
  const tasks = agent.tasks ?? store.overview?.tasks.map(task => task.id) ?? [];
  const model = store.overview?.claude.models.find(entry => entry.id === agent.model);
  const runs = providers.length * tasks.length;

  return (
    <div className="flex items-center gap-2">
      {blocked && !running && <span className="hidden text-xs text-muted-foreground md:inline">{blocked}</span>}
      {running && (
        <Button variant="outline" className="text-destructive" onClick={() => store.cancel(test).then(() => toast("Cancelling", { description: "Sandboxes are being destroyed." })).catch(error => toast.error((error as Error).message))}>
          <Square className="fill-current" />Cancel
        </Button>
      )}
      <Button size="lg" className="min-w-28" disabled={running || starting || Boolean(blocked)} onClick={() => (spends ? setConfirming(true) : start())}>
        {running || starting ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
        {running ? "Running" : test === "capabilities" ? "Quick verify" : "Run"}
      </Button>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{test === "agent" ? "Start the agent test?" : "Start the load test?"}</DialogTitle>
            <DialogDescription>This spends real money. Slide to start, or press Escape to go back.</DialogDescription>
          </DialogHeader>
          {test === "agent" ? (
            <div className="space-y-3 text-sm">
              <p><b className="tabular">{providers.length} provider{providers.length === 1 ? "" : "s"} x {tasks.length} task{tasks.length === 1 ? "" : "s"} = {runs} agent run{runs === 1 ? "" : "s"}</b> with <code className="font-mono">{agent.model}</code> at effort <code className="font-mono">{agent.effort}</code>, each in a fresh sandbox.</p>
              <div className="rounded-lg border bg-muted/40 p-4 text-center">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Rough cost</div>
                <div className="tabular text-3xl font-semibold">{fmt(runs * (model?.estimatePerTaskUsd ?? 0), "$")}</div>
                <div className="mt-1 text-xs text-muted-foreground">about 60k input and 6k output tokens per task, no cache discount</div>
              </div>
              <p className="text-xs text-muted-foreground">Each task stops after {agent.maxTurns} turns or {agent.timeLimitMin} minutes.{model?.fallback ? " Refusal fallback is on." : ""} Real costs show in the results.</p>
            </div>
          ) : (
            <p className="text-sm">This creates <b className="tabular">{store.options.load.n * providers.length}</b> real sandboxes at once ({store.options.load.n} on each of {providers.map(module => store.provider(module)?.title).join(", ")}). Cloud providers bill for them; every one is destroyed when the run ends or is cancelled.</p>
          )}
          <div className="pt-2"><SlideToStart onConfirm={start} /></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
