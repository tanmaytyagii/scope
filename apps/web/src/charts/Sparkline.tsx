/**
 * A word-sized trend: the de-emphasis ink for history and the accent for the latest value.
 * It sits beside the number it summarizes, which carries the value itself.
 */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  label,
  domain,
}: {
  values: Array<number | null>;
  width?: number;
  height?: number;
  label: string;
  /** Fixed [min, max], e.g. [0, 1] for pass rates. */
  domain?: [number, number];
}) {
  const points = values
    .map((v, i) => (v === null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null);
  if (points.length === 0) return null;
  const min = domain?.[0] ?? Math.min(...points.map((p) => p.v));
  const max = domain?.[1] ?? Math.max(...points.map((p) => p.v));
  const span = max - min || 1;
  const pad = 3;
  const px = (i: number) =>
    values.length <= 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - 2 * pad);
  const py = (v: number) => pad + (1 - (v - min) / span) * (height - 2 * pad);
  const d = points.map((p, k) => `${k ? 'L' : 'M'}${px(p.i)},${py(p.v)}`).join(' ');
  const last = points[points.length - 1] as { i: number; v: number };
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block shrink-0">
      {points.length > 1 && (
        <path
          d={d}
          fill="none"
          stroke="var(--text-3)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle cx={px(last.i)} cy={py(last.v)} r={2.5} fill="var(--accent)" />
    </svg>
  );
}
