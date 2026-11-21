import { useCallback, useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { ExternalLink, Loader2, Maximize2, Minimize2, MonitorPlay, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { LivePreview } from "@/components/LivePreview";
import { safeUrl } from "@/lib/format";
import type { DesktopConnection } from "@/lib/types";
import { cn } from "@/lib/utils";

type Status = "connecting" | "connected" | "disconnected" | "ended";

/** A real RFB stream. Viewer-only providers retain the iframe fallback. */
export function LiveDesktop({ connection, live, onReconnect }: {
  connection: DesktopConnection;
  live: boolean;
  onReconnect: () => Promise<void>;
}) {
  if (!connection.websocketUrl)
    return <LivePreview title="Desktop" icon={<MonitorPlay />} url={connection.url} live={live} />;
  return <RfbDesktop connection={connection} live={live} onReconnect={onReconnect} />;
}

function RfbDesktop({ connection, live, onReconnect }: {
  connection: DesktopConnection;
  live: boolean;
  onReconnect: () => Promise<void>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const client = useRef<RFB | null>(null);
  const reconnect = useRef(onReconnect);
  const active = useRef(live);
  const mounted = useRef(true);
  const attempts = useRef(0);
  const control = useRef(false);
  const refreshing = useRef(false);
  const connectionKey = useRef("");
  connectionKey.current = `${connection.websocketUrl}\n${connection.expiresAt ?? ""}`;
  const [status, setStatus] = useState<Status>(live ? "connecting" : "ended");
  const [error, setError] = useState("");
  const [allowControl, setAllowControl] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const href = safeUrl(connection.url);

  // noVNC's mouse-capture overlay lives under body, outside the fullscreen top layer. In fullscreen,
  // the canvas can consume mouseup before that overlay sees it. Release through its window listener
  // after the original event, and on blur/disconnect, so capture never blocks the surrounding app.
  const releaseInputCapture = useCallback((event?: MouseEvent) => {
    if ((document as Document & { captureElement?: Element }).captureElement !== canvas.current || !canvas.current) return;
    window.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, buttons: 0, clientX: event?.clientX ?? 0, clientY: event?.clientY ?? 0,
    }));
  }, []);

  useEffect(() => {
    reconnect.current = onReconnect; active.current = live;
    if (!live && document.fullscreenElement === panel.current) void document.exitFullscreen().catch(() => undefined);
  }, [onReconnect, live]);
  useEffect(() => {
    mounted.current = true;
    const changed = () => { releaseInputCapture(); setFullscreen(document.fullscreenElement === panel.current); };
    const blurred = () => releaseInputCapture();
    document.addEventListener("fullscreenchange", changed);
    window.addEventListener("blur", blurred);
    return () => { mounted.current = false; releaseInputCapture(); document.removeEventListener("fullscreenchange", changed); window.removeEventListener("blur", blurred); };
  }, [releaseInputCapture]);
  useEffect(() => {
    if (!allowControl) releaseInputCapture();
    control.current = allowControl;
    if (client.current) client.current.viewOnly = !allowControl;
  }, [allowControl, releaseInputCapture]);

  const refresh = useCallback(async (manual = false) => {
    if (refreshing.current || !active.current) return;
    if (manual) attempts.current = 0;
    refreshing.current = true;
    setStatus("connecting");
    setError("");
    const previousKey = connectionKey.current;
    try {
      await reconnect.current();
      // SSE may already have delivered fresh credentials and reconnected us before the POST returns.
      if (mounted.current && active.current && connectionKey.current === previousKey)
        setGeneration(value => value + 1);
    } catch {
      if (mounted.current && active.current) {
        setStatus("disconnected");
        setError("Could not refresh desktop access. Try reconnecting.");
      }
    } finally { refreshing.current = false; }
  }, []);

  useEffect(() => {
    if (!live) { setStatus("ended"); return; }
    let url: URL;
    try {
      url = new URL(connection.websocketUrl!);
      if (url.protocol !== "wss:" || url.username || url.password) throw new Error();
    } catch {
      setStatus("disconnected"); setError("The provider returned an invalid desktop connection."); return;
    }
    let disposed = false;
    let rfb: RFB | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let authFailed = false;
    setStatus("connecting"); setError("");

    // Load the decoder only for an open desktop, not with the rest of the playground bundle.
    void import("@novnc/novnc").then(({ default: RemoteFrameBuffer }) => {
      if (disposed || !screen.current) return;
      rfb = new RemoteFrameBuffer(screen.current, url.href, { shared: true });
      client.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = !control.current;
      rfb.showDotCursor = true;
      rfb.addEventListener("connect", () => {
        if (disposed) return;
        clearTimeout(timeout);
        canvas.current = screen.current?.querySelector("canvas") ?? null;
        attempts.current = 0;
        setStatus("connected"); setError("");
      });
      const authenticationFailed = () => {
        authFailed = true;
        if (!disposed) setError("Desktop authentication failed. Check the sandbox image and reconnect.");
      };
      rfb.addEventListener("securityfailure", authenticationFailed);
      rfb.addEventListener("credentialsrequired", authenticationFailed);
      rfb.addEventListener("disconnect", () => {
        clearTimeout(timeout);
        releaseInputCapture();
        if (disposed) return;
        setStatus("disconnected");
        if (!authFailed && attempts.current < 3) {
          const delay = 1000 * 2 ** attempts.current++;
          retry = setTimeout(() => void refresh(), delay);
        } else if (!authFailed) setError("Desktop connection lost. Reconnect to try again.");
      });
      timeout = setTimeout(() => { if (!disposed) rfb?.disconnect(); }, 20_000);
      const expires = Date.parse(connection.expiresAt ?? "");
      if (Number.isFinite(expires))
        expiry = setTimeout(() => void refresh(), Math.max(1000, expires - Date.now() - 30_000));
    }).catch(() => {
      if (!disposed) { setStatus("disconnected"); setError("Could not load the desktop viewer. Reconnect to try again."); }
    });
    return () => {
      disposed = true;
      clearTimeout(retry); clearTimeout(timeout); clearTimeout(expiry);
      releaseInputCapture();
      rfb?.disconnect();
      if (client.current === rfb) client.current = null;
    };
  }, [connection.websocketUrl, connection.expiresAt, live, generation, refresh, releaseInputCapture]);

  const connected = live && status === "connected";
  const toggleFullscreen = () => {
    const action = document.fullscreenElement === panel.current ? document.exitFullscreen() : panel.current?.requestFullscreen();
    void action?.catch(() => setError("Fullscreen is unavailable in this browser."));
  };
  return (
    <div ref={panel} data-desktop-state={live ? status : "ended"} className="desktop-panel overflow-hidden rounded-lg border bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <MonitorPlay className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">Desktop</span>
        <span role="status" aria-live="polite" className={cn("mr-auto flex items-center gap-1.5 text-xs", connected ? "text-success" : "text-muted-foreground")}>
          {live && status === "connecting" ? <Loader2 className="size-3 animate-spin" /> : <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-muted-foreground")} />}
          {!live ? "Session ended" : status === "connected" ? "Live" : status === "connecting" ? "Connecting" : "Disconnected"}
        </span>
        {live && <>
          <label className="flex items-center gap-2 text-xs">Control<Switch aria-label="Enable desktop control" checked={allowControl} onCheckedChange={setAllowControl} disabled={!connected} /></label>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Reconnect desktop" onClick={() => void refresh(true)}><RotateCw className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label={fullscreen ? "Exit desktop fullscreen" : "Fullscreen desktop"} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</Button>
          {href && <Button asChild size="icon" variant="ghost" className="size-7"><a href={href} target="_blank" rel="noopener noreferrer" aria-label="Open desktop in a new tab"><ExternalLink className="size-3.5" /></a></Button>}
        </>}
      </div>
      <div className="desktop-screen relative aspect-[4/3] bg-black">
        {live && <div ref={screen} className="absolute inset-0" aria-label="Remote desktop screen"
          onMouseUpCapture={event => { const native = event.nativeEvent; queueMicrotask(() => releaseInputCapture(native)); }} />}
        {!connected && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-zinc-400">
          {error || (!live ? "This desktop session has ended." : status === "connecting" ? "Connecting to the sandbox’s desktop…" : "Waiting to reconnect…")}
        </div>}
      </div>
      {live && <p className="border-t px-3 py-2 text-xs text-muted-foreground">{allowControl ? "Control enabled · click the desktop to focus the keyboard." : "View only · enable Control to use the mouse and keyboard."}</p>}
    </div>
  );
}
