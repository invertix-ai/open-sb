import { MonitorPlay } from "lucide-react";
import { LiveDesktop } from "@/components/LiveDesktop";
import { CounterStat, ProviderCard } from "@/components/ProviderCard";
import { Field, TestLayout, Waiting } from "@/components/TestLayout";
import { Switch } from "@/components/ui/switch";
import { useStore } from "@/lib/store";
import { NumberInput } from "./SpeedTab";

export function DesktopTab() {
  const store = useStore();
  const options = store.options.desktop;
  const supported = store.selectedAvailable().filter(module => store.provider(module)?.capabilities.includes("desktop"));
  return <TestLayout test="desktop" gridClassName="grid-cols-1 2xl:grid-cols-2"
    options={<>
      <Field label="Session duration" hint="Automatically destroys the sandbox when time is up.">
        <div className="w-fit"><NumberInput label="Session duration in minutes" value={options.durationS / 60} min={0.5} max={60} step={0.5} suffix="min" onChange={value => store.setOption("desktop", "durationS", value * 60)} /></div>
      </Field>
      <Field label="Open a live demo" hint="A clock and input test, rendered inside the remote browser.">
        <Switch aria-label="Open desktop demo" checked={options.demo} onCheckedChange={value => store.setOption("desktop", "demo", value)} />
      </Field>
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><MonitorPlay className="size-4" />{supported.length ? supported.map(module => store.provider(module)?.title).join(", ") : "Select E2B, Daytona or Boat in the sidebar."}</p>
    </>}
    card={(view, module) => {
      const run = view.p[module]!;
      return <ProviderCard module={module} run={run}>
        {run.metrics.desktop_ready_ms !== undefined && <div className="max-w-48"><CounterStat label="Desktop ready" value={run.metrics.desktop_ready_ms} unit="ms" /></div>}
        {!run.desktop && run.status === "running" && <Waiting lines={3} />}
        {run.desktop && <LiveDesktop key={run.desktop.sandboxId} connection={run.desktop} live={run.status === "running"} onReconnect={() => store.reconnectDesktop("desktop", module)} />}
      </ProviderCard>;
    }} />;
}
