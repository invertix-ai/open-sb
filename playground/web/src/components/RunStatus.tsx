// The live run status in the header: the Dynamic island block (bencho, adapted). Shut, it shows the run's clock
// (or Idle) and the sandboxes alive; pressed during a run, it opens to the test, its providers and a stop button.
import { toast } from "sonner";
import { Island } from "@/bencho/dynamic-island/Island";
import "@/bencho/dynamic-island/Island.css";
import { TESTS, useStore } from "@/lib/store";

export function RunStatus() {
  const store = useStore();
  const running = Object.values(store.views).filter(view => view?.status === "running");
  const view = running[0];
  const label = view ? TESTS.find(test => test.id === view.test)?.label ?? view.test : "";
  const detail = view
    ? `${view.providers.length} provider${view.providers.length === 1 ? "" : "s"} · ${store.live} sandbox${store.live === 1 ? "" : "es"} alive${running.length > 1 ? ` · +${running.length - 1} more run` : ""}`
    : "";
  return (
    <div className="bencho relative h-9 w-[150px]">
      <div className="absolute left-1/2 top-0 z-40 -translate-x-1/2">
        <Island running={Boolean(view)} title={label} detail={detail} startedAt={view?.startedAt} live={store.live}
          onStop={view ? () => store.cancel(view.test).then(() => toast("Cancelling", { description: "Sandboxes are being destroyed." })).catch(error => toast.error((error as Error).message)) : undefined} />
      </div>
    </div>
  );
}
