// A live view of something inside a sandbox, embedded in its card: the desktop viewer, or a port's page. Only
// URLs that open without credentials ever reach the browser (the server keeps the others), and only HTTPS ones
// are framed (the page's CSP allows https: frames); the rest get the open-in-new-tab button alone. Once the
// sandbox is gone the frame is replaced by a note, since its address no longer answers.
import { useState, type ReactNode } from "react";
import { ExternalLink, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeUrl } from "@/lib/format";
import { cn } from "@/lib/utils";

export function LivePreview({ title, icon, url, live, className }: {
  title: string;
  icon: ReactNode;
  url: string;
  /** Whether the sandbox behind the URL still exists. */
  live: boolean;
  className?: string;
}) {
  const [reloads, setReloads] = useState(0);
  const href = safeUrl(url);
  if (!href) return null;
  const framed = href.startsWith("https:");
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-muted/20", className)}>
      <div className="flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5">
        <span className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        <span className="shrink-0 text-xs font-medium">{title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground" title={new URL(href).host}>{new URL(href).host}</span>
        {framed && live && (
          <Button size="icon" variant="ghost" className="size-6" title="Reload" aria-label={`Reload ${title}`} onClick={() => setReloads(n => n + 1)}><RotateCw className="size-3.5" /></Button>
        )}
        {live && (
          <Button asChild size="sm" variant="outline" className="h-6 px-2 text-[11px]">
            <a href={href} target="_blank" rel="noopener noreferrer" title="Open in a new tab"><ExternalLink className="size-3" />Open</a>
          </Button>
        )}
      </div>
      {live && framed && (
        <iframe key={reloads} src={href} title={title} className="aspect-video w-full bg-background"
          sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" referrerPolicy="no-referrer" loading="lazy" />
      )}
      {live && !framed && <p className="px-3 py-2 text-xs text-muted-foreground">Not served over HTTPS, so it cannot be embedded here. Open it in a new tab.</p>}
      {!live && <p className="px-3 py-2 text-xs text-muted-foreground">The sandbox was destroyed, so this view has closed.</p>}
      {live && framed && <p className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">Blank? Some pages refuse to be embedded: open it in a new tab.</p>}
    </div>
  );
}
