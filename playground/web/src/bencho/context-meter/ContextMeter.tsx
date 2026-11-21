import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/* ══ Context meter ════════════════════════════════════════
   A model's context window as a field of dots, one per thousand
   tokens. Each kind of content fills its own band, column by column,
   in its own strength of ink, and the empty room is a faint grid.
   Point at a chip, or at any dot, and that kind lights while the rest
   fall back, and the big number rolls to its share. Compact folds the
   conversation down: its dots go out in a ripple from the far end,
   the bands after it close up, and the count rolls down with them.

   ── EVERY DOT IS AN INDEX ───────────────────────────────
   Dot i belongs to whichever kind's running total it falls inside,
   so a dot never moves: compacting changes which kind each index
   belongs to, and the colour change is the animation. A delay that
   grows along the indices that changed makes it a ripple rather
   than a cut.

   ── THE FIGURE POPS IN ──────────────────────────────────
   The Price flow block's number pop-in, recycled: a digit that
   changes rises a hair out of a 2px blur and lands a touch past
   its mark, left to right 70ms apart, from below when the figure
   grows, from above when it shrinks. Every digit is keyed by its
   place and its value, so one that did not change never moves. */

// open-sb change: the demo context window (its fixed kinds, the dot field and the Compact action) is gone. The
// meter now draws the segments it is given, as one stacked bar, with their values formatted by the caller.
export type Segment = { id: string; name: string; value: number; colour: string };

function Roll({ text, up }: { text: string; up: boolean }) {
  const chars = text.split("");
  /* places counted from the right, so a new leading digit does not
     shift the keys of the ones already there */
  return (
    <span className="ctx-roll" aria-hidden="true">
      {chars.map((c, i) => {
        const place = chars.length - 1 - i;
        if (!/[0-9]/.test(c)) return <span key={`s${place}`} className="ctx-sym">{c}</span>;
        return (
          <span key={`p${place}`} className="ctx-wheel">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={c}
                className="ctx-digit"
                initial={{ y: up ? "0.18em" : "-0.18em", opacity: 0, filter: "blur(2px)" }}
                animate={{ y: "0em", opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(2px)", transition: { duration: 0.16 } }}
                transition={{ duration: 0.5, ease: [0.34, 1.45, 0.64, 1], delay: i * 0.07 }}
              >
                {c}
              </motion.span>
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
}

/* the bar's corners: OUTER at its two ends, INNER where pieces meet */
const OUTER = 6;
const INNER = 2;
const corners = (first: boolean, last: boolean) => ({
  borderTopLeftRadius: first ? OUTER : INNER,
  borderBottomLeftRadius: first ? OUTER : INNER,
  borderTopRightRadius: last ? OUTER : INNER,
  borderBottomRightRadius: last ? OUTER : INNER,
});

export function ContextMeter({
  // open-sb change: what the meter shows, from the caller.
  title,
  segments,
  /* the whole window; anything not filled is the faint tail. Default: the sum of the segments */
  total,
  format = (value: number) => String(Math.round(value)),
  /* the words after the big number when nothing is pointed at */
  of,
}: {
  title: string;
  segments: Segment[];
  total?: number;
  format?: (value: number) => string;
  of?: string;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const used = segments.reduce((a, c) => a + Math.max(0, c.value), 0);
  const room = Math.max(0, (total ?? used) - used);
  /* biggest first, as the original orders its bands */
  const order = [...segments].sort((a, b) => b.value - a.value);
  const hotSeg = hot ? segments.find((c) => c.id === hot) : undefined;
  const target = hotSeg ? hotSeg.value : used;
  /* which way the wheels turn: up for more, down for less */
  const last = useRef(target);
  const up = useRef(true);
  if (target !== last.current) { up.current = target > last.current; last.current = target; }

  return (
    <div className="ctx" data-hot={hot || undefined} onPointerLeave={() => setHot(null)}>
      <div className="ctx-head">
        <span className="ctx-title">{title}</span>
      </div>
      <div className="ctx-figure" aria-live="polite">
        <span className="ctx-num">
          <span className="ctx-sr">{format(target)}</span>
          <Roll text={format(target)} up={up.current} />
        </span>
        <span className="ctx-of">{hotSeg ? hotSeg.name : of ?? ""}</span>
      </div>
      <div className="ctx-bar" aria-hidden="true" onPointerLeave={() => setHot(null)}>
        {order.map((c, n) => (
          <i
            key={c.id}
            className="ctx-seg"
            data-kind={c.id}
            data-dim={hot !== null && c.id !== hot || undefined}
            style={{
              flexGrow: Math.max(0, c.value),
              ...corners(n === 0, n === order.length - 1 && room === 0),
              // open-sb change: each segment carries its own colour instead of a fixed kind's
              "--seg": c.colour,
            } as React.CSSProperties}
            onPointerEnter={() => setHot(c.id)}
          />
        ))}
        {(room > 0 || used === 0) && (
          <i
            className="ctx-seg ctx-seg-room"
            style={{ flexGrow: used === 0 ? 1 : room, ...corners(used === 0, true) }}
            data-dim={hot !== null || undefined}
            onPointerEnter={() => setHot(null)}
          />
        )}
      </div>
      <div className="ctx-chips" onPointerLeave={() => setHot(null)}>
        {order.map((c) => (
          <button
            key={c.id}
            type="button"
            className="ctx-chip"
            data-on={hot === c.id || undefined}
            onPointerEnter={() => setHot(c.id)}
            onFocus={() => setHot(c.id)}
            onBlur={() => setHot(null)}
          >
            <i className="ctx-swatch" style={{ "--seg": c.colour } as React.CSSProperties} />
            {c.name}
            {/* open-sb change: the value beside each name */}
            <span className="ctx-chip-v">{format(c.value)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
