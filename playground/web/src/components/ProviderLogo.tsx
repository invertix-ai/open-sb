// A provider's logo on a light tile (logos come in every colour), or a monogram when there is none.
import { cn } from "@/lib/utils";
import { colorFor } from "@/lib/format";
import { useStore } from "@/lib/store";

export function ProviderLogo({ module, size = 28, className, dim }: { module: string; size?: number; className?: string; dim?: boolean }) {
  const store = useStore();
  const entry = store.provider(module);
  const style = { width: size, height: size };
  if (entry?.logo)
    return (
      <span style={style} className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-black/5", dim && "opacity-50 grayscale", className)}>
        <img src={entry.logo} alt="" className="size-[78%] object-contain" loading="lazy" />
      </span>
    );
  const letters = (entry?.title ?? module).split(/\s+/).map(word => word[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span style={{ ...style, background: colorFor(module, store.order) }} className={cn("inline-flex shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-black/80", dim && "opacity-50 grayscale", className)}>
      {letters}
    </span>
  );
}
