/**
 * Inline SVG chart rendering, following the dataviz skill's method: form
 * picked before color, categorical color assigned in fixed order (never
 * cycled), status colors reserved for verdicts and never reused as a
 * series color, thin marks with rounded data-ends, a surface gap between
 * adjacent bars, direct labels used selectively (the value at the bar's
 * end, not on every element), and text carrying text-ink tokens rather
 * than the series color.
 */

export interface TornadoBarDatum {
  label: string;
  swing: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function formatCompactUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

const LABEL_FONT = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
let measureCtx: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string): number {
  if (measureCtx === undefined) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  if (!measureCtx) return text.length * 7; // fallback estimate if canvas 2D context is unavailable
  measureCtx.font = LABEL_FONT;
  return measureCtx.measureText(text).width;
}

/** Truncates with an ellipsis (never a hard clip) so a label that doesn't fit shrinks legibly instead of losing characters off one end. The full label always still rides on the bar via a native <title> tooltip. */
function truncateToWidth(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(text.slice(0, mid) + ellipsis) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

/** Horizontal bar chart, one series (swing magnitude), ranked descending — a tornado chart needs no legend since a single series' identity is already named by the chart title. */
export function renderTornadoChart(container: HTMLElement, data: TornadoBarDatum[]): void {
  container.innerHTML = "";
  if (data.length === 0) return;

  const barHeight = 22;
  const barGap = 10;
  const rowHeight = barHeight + barGap;
  const rightPad = 90;
  const chartWidth = 560;
  const labelPad = 12;
  const minLabelWidth = 110;
  const maxLabelWidth = 240;
  // Measure first: size the label column to the longest label actually being drawn
  // (never a hard clip), capped so the plot area doesn't collapse on a long label.
  const widestLabel = Math.max(...data.map((d) => textWidth(d.label)), 0);
  const leftLabelWidth = Math.min(Math.max(widestLabel + labelPad * 2, minLabelWidth), maxLabelWidth);
  const plotWidth = chartWidth - leftLabelWidth - rightPad;
  const height = data.length * rowHeight + 8;
  const maxSwing = Math.max(...data.map((d) => d.swing), 1);

  const svg = el("svg", { viewBox: `0 0 ${chartWidth} ${height}`, width: "100%", height, role: "img", "aria-label": "Tornado sensitivity chart" });

  data.forEach((d, i) => {
    const y = i * rowHeight + 4;
    const barWidth = Math.max((d.swing / maxSwing) * plotWidth, 2);
    const availableLabelWidth = leftLabelWidth - labelPad;

    const label = el("text", {
      x: leftLabelWidth - labelPad,
      y: y + barHeight / 2 + 4,
      "text-anchor": "end",
      class: "viz-label",
    });
    label.textContent = truncateToWidth(d.label, availableLabelWidth);
    const titleEl = el("title", {});
    titleEl.textContent = d.label;
    label.appendChild(titleEl);
    svg.appendChild(label);

    const track = el("rect", {
      x: leftLabelWidth,
      y,
      width: plotWidth,
      height: barHeight,
      rx: 4,
      class: "viz-track",
    });
    svg.appendChild(track);

    const bar = el("rect", {
      x: leftLabelWidth,
      y,
      width: barWidth,
      height: barHeight,
      rx: 4,
      class: "viz-bar-series-1",
    });
    svg.appendChild(bar);

    const value = el("text", {
      x: leftLabelWidth + barWidth + 8,
      y: y + barHeight / 2 + 4,
      class: "viz-value",
    });
    value.textContent = formatCompactUsd(d.swing);
    svg.appendChild(value);
  });

  container.appendChild(svg);
  container.appendChild(buildTableFallback(["Driver", "NPV swing"], data.map((d) => [d.label, formatCompactUsd(d.swing)])));
}

/** A collapsed, plain-HTML table holding the same numbers as the chart above it —
 * the dataviz skill's accessibility pass requires a table view to exist alongside
 * every chart, since an SVG-only chart gives a screen reader or a printed page
 * nothing to read. Collapsed by default so it doesn't compete with the chart. */
function buildTableFallback(headers: string[], rows: string[][]): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "viz-table-fallback";
  const summary = document.createElement("summary");
  summary.textContent = "View as table";
  details.appendChild(summary);

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  details.appendChild(table);
  return details;
}

export interface RangeDatum {
  label: string;
  p90: number;
  p50: number;
  p10: number;
}

/** A P90/P50/P10 range plot: a thin connecting line from P90 to P10 with the P50 marked, so the reader sees the range and the median in one glance rather than three separate stat tiles doing that job worse. */
export function renderRangeChart(container: HTMLElement, datum: RangeDatum): void {
  container.innerHTML = "";

  const width = 560;
  const height = 90;
  const leftPad = 16;
  const rightPad = 16;
  const plotWidth = width - leftPad - rightPad;
  const midY = 44;

  const min = Math.min(datum.p90, datum.p50, datum.p10, 0);
  const max = Math.max(datum.p90, datum.p50, datum.p10, 0);
  const range = max - min || 1;
  const xFor = (v: number) => leftPad + ((v - min) / range) * plotWidth;

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img", "aria-label": "NPV range: P90 to P10" });

  // zero reference line, if zero falls within the plotted range
  if (min < 0 && max > 0) {
    const zeroX = xFor(0);
    svg.appendChild(el("line", { x1: zeroX, x2: zeroX, y1: 12, y2: 76, class: "viz-zero-line" }));
  }

  // connecting line P90 -> P10
  svg.appendChild(el("line", { x1: xFor(datum.p90), x2: xFor(datum.p10), y1: midY, y2: midY, class: "viz-range-line" }));

  // endpoint markers
  const p90Dot = el("circle", { cx: xFor(datum.p90), cy: midY, r: 6, class: "viz-dot-muted" });
  const p10Dot = el("circle", { cx: xFor(datum.p10), cy: midY, r: 6, class: "viz-dot-muted" });
  const p50Dot = el("circle", { cx: xFor(datum.p50), cy: midY, r: 7, class: "viz-dot-series-1" });
  svg.appendChild(p90Dot);
  svg.appendChild(p10Dot);
  svg.appendChild(p50Dot);

  // Measure first: a center-anchored label near either edge would otherwise overflow
  // past the viewBox and get clipped, so clamp its anchor x to keep the full label on-canvas.
  const clampedCenterX = (centerX: number, text: string): number => {
    const halfWidth = textWidth(text) / 2;
    return Math.min(Math.max(centerX, halfWidth), width - halfWidth);
  };

  const p90Text = `P90 ${formatCompactUsd(datum.p90)}`;
  const p10Text = `P10 ${formatCompactUsd(datum.p10)}`;
  const p50Text = `P50 ${formatCompactUsd(datum.p50)}`;

  const p90Label = el("text", { x: clampedCenterX(xFor(datum.p90), p90Text), y: midY - 16, "text-anchor": "middle", class: "viz-value-muted" });
  p90Label.textContent = p90Text;
  const p10Label = el("text", { x: clampedCenterX(xFor(datum.p10), p10Text), y: midY - 16, "text-anchor": "middle", class: "viz-value-muted" });
  p10Label.textContent = p10Text;
  const p50Label = el("text", { x: clampedCenterX(xFor(datum.p50), p50Text), y: midY + 26, "text-anchor": "middle", class: "viz-value" });
  p50Label.textContent = p50Text;

  svg.appendChild(p90Label);
  svg.appendChild(p10Label);
  svg.appendChild(p50Label);

  container.appendChild(svg);
  container.appendChild(
    buildTableFallback(
      ["Percentile", "NPV"],
      [
        ["P90 (conservative)", formatCompactUsd(datum.p90)],
        ["P50 (median)", formatCompactUsd(datum.p50)],
        ["P10 (optimistic)", formatCompactUsd(datum.p10)],
      ],
    ),
  );
}

export { formatCompactUsd };
