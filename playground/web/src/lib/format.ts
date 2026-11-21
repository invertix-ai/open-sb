// Number formatting for metrics. Missing values show as a dash.

export function fmt(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (unit === "ms") return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  if (unit === "MB/s") return `${value >= 100 ? Math.round(value) : value.toFixed(1)} MB/s`;
  if (unit === "%") return `${Math.round(value * 100)}%`;
  if (unit === "$") return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  if (unit === "tok") return value >= 1_000_000 ? `${(value / 1e6).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
  return `${Math.round(value * 10) / 10}${unit ? ` ${unit}` : ""}`;
}

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** One colour per provider, stable across views. */
const PALETTE = ["#7c9cff", "#3ccf91", "#f5b94a", "#ff7a90", "#5ad1e6", "#b48cff", "#ff9f5a", "#9be15d", "#e66bd3", "#6be6b8", "#ffd166", "#8fa3ff", "#f78c6b", "#4dd4ac", "#c792ea", "#82aaff", "#f07178"];
export const colorFor = (module: string, order: string[]) => PALETTE[Math.max(0, order.indexOf(module)) % PALETTE.length]!;

export const safeUrl = (url: string) => {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; }
};
