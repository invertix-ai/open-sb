import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
// open-sb change: the icons this run status uses
import { Activity, Boxes, Square } from "lucide-react";

/* ── inlined from lab/spring ──────────────────────── */
/* ── one spring, for everything that settles ───────────────
   The maths was already on this bench twice, copied by hand:
   Humidity's wheel and Brightness's column both accumulate
   velocity toward a target, damp it, and snap when both the
   delta and the velocity fall under 0.02. Two copies is a
   coincidence; five would be a policy, so it comes out here
   before the elastic blocks are written against it.

   The two shipped copies are deliberately NOT refactored onto
   this. They work, they are tuned, and rewriting the innards
   of two live components to prove a point about duplication
   is how a good afternoon becomes a bad one. This is the one
   new code uses.

   Frames, not milliseconds. `dt` is expressed in sixtieths of
   a second and the damping is RAISED to it rather than
   multiplied by it, so a dropped frame decays the same amount
   of energy as the two frames it replaced. Multiplying is the
   version that makes a spring behave differently on a busy
   page, which is the hardest kind of bug to see.

   The loop parks itself the moment the value has settled.
   CLAUDE.md is not complimentary about the one permanent
   requestAnimationFrame already on this bench and there is no
   case for five more. */

/* Read once, the way the wheel and the pill nav do. A
   preference, not a live input. */
const stillness = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// open-sb change: the demo pictures (placeholder avatars and album art) are gone; nothing here shows a picture.

/* ══ Dynamic island ═══════════════════════════════════════
   A black pill at the top of a phone that holds a live
   activity. Press it and it grows into the full activity;
   press again and it tucks back into the pill. Which activity
   is running, a timer, a call, music or a flight, is set by the
   block: each is its own card on the wall, the same island under it.

   ── THE SHAPE IS ONE SPRING, THE CONTENT IS NOT ──────────
   Width, height and corner ride one spring, so the pill grows
   as one object and never as a box whose corners catch up
   later. The contents do not morph with it: the compact row
   and the expanded card are two different layouts, and
   stretching one into the other is the thing that looks
   cheap. They crossfade instead, through a small blur and a
   scale, the old one leaving a beat before the new one
   arrives, so for an instant there is only the black shape
   moving, which is what makes it read as the same object
   changing rather than as two panels swapped.

   ── CENTRED IN THE BLOCK ─────────────────────────────────
   On a phone it hangs from the top edge; here there is no
   phone around it, so it sits in the middle of the block and
   grows out evenly from there.

   The island is black whatever the Fill is, it is the screen
   switched off around a camera, not a surface of the app , 
   unless the Island knob asks for white, which inverts its
   ink and deepens the colours that were tuned for black. */

// open-sb change: one activity, a playground run. The timer, call, music and flight demos are gone. Shut, the pill
// shows the run's clock (or Idle) and the sandboxes alive; pressed while a run is going, it grows into the run:
// its name, what it is running on, the elapsed time and a stop button.
const COMPACT = { w: 150, h: 36, r: 18 };
const OPEN = { w: 360, h: 76, r: 38 };
/* a new activity arriving while shut: the pill swells a touch
   past its own size and settles, the way the real one nods
   when something starts */
const NUDGE = 1.08;

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => `${Math.floor(s / 60)}:${pad(s % 60)}`;

const FADE = {
  initial: { opacity: 0, scale: 0.92, filter: "blur(6px)" },
  animate: { opacity: 1, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, scale: 0.92, filter: "blur(6px)" },
};

export function Island({
  /* how much the shape overshoots, 0..100 */
  bounce = 40,
  /* the island's own colour: the hardware black, or white */
  tone = "Black",
  // open-sb change: the run it shows
  running,
  title,
  detail,
  startedAt,
  live,
  onStop,
}: {
  bounce?: number;
  tone?: string;
  running: boolean;
  title: string;
  detail: string;
  startedAt?: number;
  live: number;
  onStop?: () => void;
}) {
  const still = stillness();
  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState(0);

  /* a run starting nods the pill; one ending folds it away */
  const was = useRef(running);
  useEffect(() => {
    if (running && !was.current) setNudge((n) => n + 1);
    if (!running) setOpen(false);
    was.current = running;
  }, [running]);

  /* live numbers, so it is an activity and not a picture of one */
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const secs = running && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;

  const b = Math.max(0, Math.min(100, bounce)) / 100;
  const spring = still
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 380, damping: 34 - b * 16, mass: 0.9 };

  const size = open ? OPEN : COMPACT;

  return (
    <div className="dyn">
      <div className="dyn-top">
        <motion.button
          type="button"
          className="dyn-pill"
          data-tone={tone === "White" ? "white" : undefined}
          aria-expanded={open}
          aria-label={running ? `${title}, ${clock(secs)}. ${open ? "Close" : "Open"} the run status` : `Idle, ${live} sandboxes alive`}
          onClick={() => { if (running) setOpen((o) => !o); }}
          initial={false}
          animate={{ width: size.w, height: size.h, borderRadius: size.r, scale: 1 }}
          transition={spring}
          whileTap={still || !running ? undefined : { scale: 0.97 }}
        >
          {/* the swell on a new activity, on a wrapper of its own
              so it never fights the size spring */}
          <motion.span
            key={nudge}
            className="dyn-in"
            initial={nudge && !still ? { scale: NUDGE } : false}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 18 }}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={`${running}-${open}`}
                className={open ? "dyn-open" : "dyn-compact"}
                data-kind="Run"
                {...FADE}
                transition={{ duration: still ? 0 : 0.22, delay: still ? 0 : 0.06 }}
              >
                {open ? (
                  <>
                    <span className="dyn-round dyn-green-bg"><Activity size={20} strokeWidth={2.2} /></span>
                    <span className="dyn-who">
                      <span className="dyn-name">{title}</span>
                      <span className="dyn-label">{detail}</span>
                    </span>
                    <span className="dyn-grow" />
                    <span className="dyn-big dyn-green">{clock(secs)}</span>
                    {onStop && (
                      <span className="dyn-round dyn-red-bg dyn-stop" role="button" tabIndex={0} aria-label="Cancel the run"
                        onClick={(e) => { e.stopPropagation(); onStop(); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onStop(); } }}>
                        <Square size={14} fill="currentColor" strokeWidth={0} />
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    {running
                      ? <span className="dyn-num dyn-green dyn-lead"><i className="dyn-dot" data-on="" />{clock(secs)}</span>
                      : <span className="dyn-num dyn-idle dyn-lead"><i className="dyn-dot" />Idle</span>}
                    <span className="dyn-num dyn-live"><Boxes size={14} strokeWidth={2} />{live}</span>
                  </>
                )}
              </motion.span>
            </AnimatePresence>
          </motion.span>
        </motion.button>
      </div>
    </div>
  );
}
