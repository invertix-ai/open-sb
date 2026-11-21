// Hand-made SVG charts for the playground: horizontal bar charts with an optional p95 whisker, a histogram
// and a sparkline. Each returns an SVG string; every label goes through esc().

export const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function fmt(value, unit = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  if (unit === "ms") return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  if (unit === "MB/s") return `${value >= 100 ? Math.round(value) : value.toFixed(1)} MB/s`;
  if (unit === "%") return `${Math.round(value * 100)}%`;
  if (unit === "$") return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  return `${Math.round(value * 10) / 10}${unit ? ` ${unit}` : ""}`;
}

/**
 * rows: [{ label, value, p95?, color, winner? }]. Bars share one scale; a whisker runs from value to p95.
 * Rows without a value show "n/a" (or their `note`).
 */
export function barChart({ rows, unit = "ms", width = 520 }) {
  const rowH = 30, labelW = 128, top = 6;
  const valueW = rows.some(row => Number.isFinite(row.p95)) ? 150 : 92;
  const plotW = width - labelW - valueW - 8;
  const max = Math.max(1e-9, ...rows.flatMap(row => [row.value ?? 0, row.p95 ?? 0]).filter(Number.isFinite));
  const x = v => labelW + (Math.max(0, v) / max) * plotW;
  const valueX = width;
  const height = top + rows.length * rowH + 4;
  const body = rows.map((row, i) => {
    const y = top + i * rowH;
    const has = Number.isFinite(row.value);
    const bar = has ? `<rect x="${labelW}" y="${y + 7}" width="${Math.max(2, x(row.value) - labelW)}" height="14" rx="4" fill="${row.color}" opacity="${row.winner ? 1 : 0.72}"/>` : "";
    const whisker = has && Number.isFinite(row.p95) && row.p95 > row.value
      ? `<line x1="${x(row.value)}" x2="${x(row.p95)}" y1="${y + 14}" y2="${y + 14}" stroke="${row.color}" stroke-width="1.5" stroke-dasharray="2 2"/><line x1="${x(row.p95)}" x2="${x(row.p95)}" y1="${y + 8}" y2="${y + 20}" stroke="${row.color}" stroke-width="1.5"/>`
      : "";
    const value = has ? fmt(row.value, unit) + (Number.isFinite(row.p95) ? ` / ${fmt(row.p95, unit)}` : "") : (row.note ?? "n/a");
    return `<g>
      <text x="0" y="${y + 19}" class="c-label">${esc(row.label)}</text>
      <rect x="${labelW}" y="${y + 7}" width="${plotW}" height="14" rx="4" class="c-track"/>
      ${bar}${whisker}
      <text x="${valueX}" y="${y + 19}" text-anchor="end" class="c-value${row.winner ? " c-win" : ""}">${esc(value)}</text>
    </g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px" preserveAspectRatio="xMinYMin meet" role="img">${body}</svg>`;
}

/** bins: [{ from, to, count }] from the server. */
export function histogramChart({ bins, color, unit = "ms", width = 360, height = 120 }) {
  if (!bins?.length) return `<div class="empty-chart">No samples yet</div>`;
  const pad = { l: 6, r: 6, t: 8, b: 20 };
  const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
  const max = Math.max(1, ...bins.map(bin => bin.count));
  const w = plotW / bins.length;
  const bars = bins.map((bin, i) => {
    const h = (bin.count / max) * plotH;
    return `<rect x="${pad.l + i * w + 1}" y="${pad.t + plotH - h}" width="${Math.max(1, w - 2)}" height="${h}" rx="2" fill="${color}"><title>${esc(`${fmt(bin.from, unit)} to ${fmt(bin.to, unit)}: ${bin.count}`)}</title></rect>`
      + (bin.count ? `<text x="${pad.l + i * w + w / 2}" y="${pad.t + plotH - h - 2}" text-anchor="middle" class="c-tiny">${bin.count}</text>` : "");
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px" role="img">
    <line x1="${pad.l}" x2="${width - pad.r}" y1="${pad.t + plotH}" y2="${pad.t + plotH}" class="c-axis"/>
    ${bars}
    <text x="${pad.l}" y="${height - 5}" class="c-tiny">${esc(fmt(bins[0].from, unit))}</text>
    <text x="${width - pad.r}" y="${height - 5}" text-anchor="end" class="c-tiny">${esc(fmt(bins.at(-1).to, unit))}</text>
  </svg>`;
}

export function sparkline(values, color, width = 260, height = 36) {
  if (values.length < 2) return "";
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
