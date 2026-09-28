/** Axis math for the hand-written charts (docs/decisions/0009). Pure, unit-tested. */

/** Round tick values from 0 up to at least `max`, about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let i = 0; i * step < max + step * 1e-9; i++) ticks.push(Number((i * step).toPrecision(12)));
  const top = ticks[ticks.length - 1] as number;
  if (top < max) ticks.push(Number((top + step).toPrecision(12)));
  return ticks;
}

/** Show every n-th category label so labels of this width never collide. */
export function labelStride(bandWidth: number, labelWidth: number): number {
  if (bandWidth <= 0) return 1;
  return Math.max(1, Math.ceil((labelWidth + 8) / bandWidth));
}

/** Approximate width of an 11px axis label (IBM Plex Sans, tabular digits). */
export const AXIS_CHAR_WIDTH = 6.2;

/**
 * Which category labels to draw: every n-th, spaced by the widest label, and never the same
 * text twice in a row (e.g. four 6-hour buckets of one day all labelled with that day).
 */
export function axisLabels(labels: readonly string[], bandWidth: number): Array<string | null> {
  const widest = Math.max(1, ...labels.map((l) => l.length)) * AXIS_CHAR_WIDTH;
  const stride = labelStride(bandWidth, widest);
  let previous: string | null = null;
  let lastIndex = Number.NEGATIVE_INFINITY;
  return labels.map((label, i) => {
    if (label === previous || i - lastIndex < stride) return null;
    previous = label;
    lastIndex = i;
    return label;
  });
}

/** A path for a bar with rounded top corners and a square base (the data-end is rounded). */
export function columnPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 4,
): string {
  if (height <= 0 || width <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${y + height}`,
    'Z',
  ].join(' ');
}

/** Index of the item nearest to `px` given each item's center. */
export function nearestIndex(centers: readonly number[], px: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  centers.forEach((c, i) => {
    const d = Math.abs(c - px);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}
