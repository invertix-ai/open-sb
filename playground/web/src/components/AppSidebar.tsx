// The sidebar: wordmark, every provider (logo, name, availability, capability dots, a switch to use it in
// tests; clicking the row opens its key setup), the Claude and OpenAI keys and the clean-up action.
import { useState } from "react";
import { Boxes, KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProviderLogo } from "@/components/ProviderLogo";
import { post } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export const CAP_LABELS: Record<string, string> = {
  pause: "pause", snapshot: "snapshot", ttl: "ttl", ports: "ports", ssh: "ssh", desktop: "desktop", background: "background", persistentDisk: "persistent disk",
};

export function AppSidebar() {
  const store = useStore();
  const [cleaning, setCleaning] = useState(false);
  const providers = store.overview?.providers;
  const anySelected = store.selectedAvailable().length > 0;

  async function cleanup() {
    setCleaning(true);
    try {
      const { cleanup } = await post<{ cleanup: Record<string, { destroyed: number; skipped: number; error?: string }> }>("/api/cleanup");
      const entries = Object.entries(cleanup);
      const destroyed = entries.reduce((sum, [, entry]) => sum + entry.destroyed, 0);
      const skipped = entries.reduce((sum, [, entry]) => sum + entry.skipped, 0);
      toast.success(`Destroyed ${destroyed} sandbox${destroyed === 1 ? "" : "es"}`, { description: skipped ? `Kept ${skipped} owned by active runs.` : "Nothing labelled open-sb.playground is left." });
      for (const [module, entry] of entries) if (entry.error) toast.error(`${store.provider(module)?.title ?? module}: ${entry.error}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setCleaning(false);
      void store.pollStatus();
    }
  }

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-400 via-emerald-400 to-amber-300 text-black shadow-sm">
            <Boxes className="size-4" />
          </div>
          <div className="leading-tight">
            <div className="font-mono text-[15px] font-semibold tracking-tight">open-sb</div>
            <div className="text-xs text-muted-foreground">playground</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Providers</SidebarGroupLabel>
          <SidebarGroupAction asChild title={anySelected ? "Select none" : "Select all available"}>
            <button type="button" className="!w-auto px-1.5 text-[11px] font-normal" onClick={() => store.selectAll(!anySelected)}>{anySelected ? "None" : "All"}</button>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {!providers && Array.from({ length: 8 }, (_, i) => <SidebarMenuItem key={i}><SidebarMenuSkeleton showIcon /></SidebarMenuItem>)}
              {providers?.map(entry => {
                const on = entry.available && store.selected.has(entry.module);
                return (
                  <SidebarMenuItem key={entry.module} className={cn("group/provider rounded-lg", on && "bg-sidebar-accent/60")}>
                    <div className="flex items-center gap-1 pr-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" onClick={() => store.openSetup(entry.module)}
                            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                            <ProviderLogo module={entry.module} size={28} dim={!entry.available} />
                            <span className="min-w-0 flex-1">
                              <span className={cn("block truncate text-[13px] font-medium", !entry.available && "text-muted-foreground")}>{entry.title}</span>
                              <span className="flex items-center gap-1.5">
                                {entry.available
                                  ? <span className="flex gap-[3px]" aria-label={`Capabilities: ${entry.capabilities.join(", ") || "core only"}`}>
                                      {Object.keys(CAP_LABELS).map(cap => <i key={cap} className={cn("size-1.5 rounded-full", entry.capabilities.includes(cap) ? "bg-success" : "bg-muted-foreground/25")} />)}
                                    </span>
                                  : <Badge variant="outline" className="h-4 max-w-36 truncate px-1.5 font-mono text-[10px] font-normal text-warning">
                                      {entry.module === "docker" ? "not running" : `set ${entry.missing[0]}${entry.missing.length > 1 ? ` +${entry.missing.length - 1}` : ""}`}
                                    </Badge>}
                              </span>
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-72">
                          {entry.available
                            ? <span>{entry.kind}. Capabilities: {entry.capabilities.map(cap => CAP_LABELS[cap]).join(", ") || "core only"}. Click to manage keys.</span>
                            : <span><b>Not available.</b> Click to enter keys, or: {entry.howToEnable}</span>}
                        </TooltipContent>
                      </Tooltip>
                      <Switch checked={on} disabled={!entry.available} onCheckedChange={value => store.toggle(entry.module, value)} aria-label={`Use ${entry.title} in tests`} />
                    </div>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-1 p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => store.openSetup("claude")}>
              <KeyRound /><span>Claude key</span>
              <Badge variant="outline" className={cn("ml-auto h-5 text-[10px] font-normal", store.overview?.claude.available ? "text-success" : "text-muted-foreground")}>{store.overview?.claude.available ? "set" : "not set"}</Badge>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => store.openSetup("openai")}>
              <KeyRound /><span>OpenAI key</span>
              <Badge variant="outline" className={cn("ml-auto h-5 text-[10px] font-normal", store.overview?.openai?.available ? "text-success" : "text-muted-foreground")}>{store.overview?.openai?.available ? "set" : "not set"}</Badge>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={cleanup} disabled={cleaning} title="Destroy every sandbox labelled open-sb.playground that no active run owns">
              {cleaning ? <Loader2 className="animate-spin" /> : <Trash2 />}<span>{cleaning ? "Cleaning up..." : "Clean up sandboxes"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <p className="px-2 pt-1 text-[11px] leading-snug text-muted-foreground">Keys stay on the server and never come back to this page.</p>
      </SidebarFooter>
    </Sidebar>
  );
}
