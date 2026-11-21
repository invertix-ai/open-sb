// The Slide to confirm block (bencho, adapted) as the last step before a run that spends money.
import { useRef } from "react";
import { SlideConfirm } from "@/bencho/slide-confirm/SlideConfirm";
import "@/bencho/slide-confirm/SlideConfirm.css";

export function SlideToStart({ onConfirm, width = 320, label = "Slide to start" }: { onConfirm: () => void; width?: number; label?: string }) {
  const fired = useRef(false);
  // A short beat after the handle lands, so the "Confirmed" state is seen before the dialog closes.
  const confirm = () => { if (fired.current) return; fired.current = true; setTimeout(onConfirm, 450); };
  return <div className="bencho flex justify-center"><SlideConfirm width={width} label={label} onConfirm={confirm} /></div>;
}
