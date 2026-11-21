// A live terminal panel: a dark, monospace, auto-scrolling frame with a Follow switch. Following keeps the
// newest line in view; scrolling up stops it (so a reader is never yanked away) and returning to the bottom, or
// the switch, resumes it. Long output blocks collapse to their first lines with an expand control.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function TerminalFrame({ title, live, meta, changeKey, children, empty, className }: {
  title: ReactNode;
  /** Shows a pulsing dot while output can still arrive. */
  live: boolean;
  /** Right-hand text in the title bar, such as a line count. */
  meta?: ReactNode;
  /** Changes whenever content is added, to scroll while following. */
  changeKey: unknown;
  children: ReactNode;
  empty?: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const toBottom = () => { if (box.current) box.current.scrollTop = box.current.scrollHeight; };

  useLayoutEffect(toBottom, []);
  useLayoutEffect(() => { if (follow) toBottom(); else setUnseen(true); }, [changeKey]);
  useEffect(() => { if (follow) { toBottom(); setUnseen(false); } }, [follow]);

  function onScroll() {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  }

  return (
    <div className={cn("dark relative flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300 shadow-inner", className)}>
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 py-1.5">
        <span className={cn("size-2 shrink-0 rounded-full", live ? "animate-pulse bg-emerald-400" : "bg-zinc-600")} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">{title}</span>
        {meta && <span className="tabular shrink-0 font-mono text-[10.5px] text-zinc-500">{meta}</span>}
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10.5px] text-zinc-400">
          Follow
          <Switch checked={follow} onCheckedChange={setFollow} className="scale-75" aria-label="Follow new output" />
        </label>
      </div>
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed">
        {children ?? <span className="text-zinc-500">{empty ?? "Waiting for output..."}</span>}
      </div>
      {!follow && unseen && (
        <button type="button" onClick={() => setFollow(true)}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/95 px-2.5 py-1 text-[11px] text-zinc-200 shadow-lg hover:bg-zinc-800">
          <ArrowDown className="size-3" />New output
        </button>
      )}
    </div>
  );
}

/** A block of command output: the first `lines` lines (and at most `chars` characters) until expanded. */
export function OutputBlock({ text, className, lines = 14, chars = 1_600 }: { text: string; className?: string; lines?: number; chars?: number }) {
  const [open, setOpen] = useState(false);
  const all = text.replace(/\n+$/, "").split("\n");
  let shown = open ? text : all.slice(0, lines).join("\n");
  if (!open && shown.length > chars) shown = shown.slice(0, chars);
  const hidden = !open && shown.length < text.replace(/\n+$/, "").length;
  if (!text.trim()) return null;
  return (
    <div className="mt-0.5">
      <pre className={cn("whitespace-pre-wrap break-all border-l-2 border-zinc-800 pl-2.5", open && "max-h-[32rem] overflow-y-auto", className)}>{shown}{hidden && <span className="text-zinc-600"> ...</span>}</pre>
      {(hidden || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="ml-2.5 mt-0.5 flex items-center gap-1 text-[10.5px] text-sky-400 hover:text-sky-300">
          {open ? <><ChevronUp className="size-3" />Collapse</> : <><ChevronDown className="size-3" />Show all {all.length > 1 ? `${all.length} lines` : `${text.length} characters`}</>}
        </button>
      )}
    </div>
  );
}
