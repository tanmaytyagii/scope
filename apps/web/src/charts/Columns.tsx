/**
 * Column chart (optionally stacked). Marks: ≤ 24px wide, 4px rounded data-end, square base,
 * 2px surface gap between stacked segments; hairline solid grid; one y-axis. Each column is its
 * own hover/focus target (the full band height, wider than the mark).
 */
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChartTooltip, useWidth } from './Frame.tsx';
import { axisLabels, columnPath, niceTicks } from './scale.ts';

export interface ColumnSegment {
  value: number;
  color: string;
}

export interface ColumnDatum {
  key: string;
  /** Axis label. */
  label: string;
  segments: ColumnSegment[];
  tooltip: ReactNode;
  href?: string;
}

const MARGIN = { top: 10, right: 8, bottom: 24, left: 44 };
const GAP = 2;

export function Columns({
  data,
  height = 180,
  yMax,
  yFormat,
  ariaLabel,
}: {
  data: ColumnDatum[];
  height?: number;
  /** Fixed top of the scale (e.g. 1 for ratios); otherwise derived from the data. */
  yMax?: number;
  yFormat: (value: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const navigate = useNavigate();

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const totals = data.map((d) => d.segments.reduce((s, x) => s + x.value, 0));
  const ticks = yMax !== undefined ? niceTicks(yMax, 4) : niceTicks(Math.max(...totals, 0), 4);
  const top = ticks[ticks.length - 1] ?? 1;
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(1, Math.min(24, band - GAP));
  const labels = axisLabels(
    data.map((d) => d.label),
    band,
  );

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!data.length) return;
    const current = active ?? data.length - 1;
    if (e.key === 'ArrowRight') setActive(Math.min(data.length - 1, current + 1));
    else if (e.key === 'ArrowLeft') setActive(Math.max(0, current - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(data.length - 1);
    else if (e.key === 'Enter' && active !== null && data[active]?.href)
      navigate(data[active]?.href as string);
    else return;
    e.preventDefault();
  };

  const activeDatum = active !== null ? data[active] : undefined;
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users get the same per-point readout as pointer users; the table view is the full equivalent
          tabIndex={0}
          onKeyDown={onKey}
          onFocus={() => setActive((a) => a ?? data.length - 1)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="block rounded-sm"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={MARGIN.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="tabular fill-fg-3 text-2xs"
              >
                {yFormat(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = MARGIN.left + i * band + (band - barW) / 2;
            let cumulative = 0;
            const visible = d.segments.filter((s) => s.value > 0);
            const last = visible[visible.length - 1];
            return (
              <g key={d.key} opacity={active !== null && active !== i ? 0.55 : 1}>
                {d.segments.map((s, j) => {
                  if (s.value <= 0) return null;
                  const y0 = y(cumulative);
                  cumulative += s.value;
                  const y1 = y(cumulative);
                  // Segments above the first leave a 2px surface gap below them.
                  const gap = cumulative - s.value > 0 ? GAP : 0;
                  const h = Math.max(0, y0 - y1 - gap);
                  return (
                    <path
                      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                      key={j}
                      d={columnPath(x, y1, barW, h, s === last ? 4 : 0)}
                      fill={s.color}
                    />
                  );
                })}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; keyboard users press Enter on the focused chart */}
                <rect
                  x={MARGIN.left + i * band}
                  y={MARGIN.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                  onClick={() => d.href && navigate(d.href)}
                  className={d.href ? 'cursor-pointer' : undefined}
                />
                {labels[i] !== null && (
                  <text
                    x={MARGIN.left + i * band + band / 2}
                    y={height - 6}
                    textAnchor="middle"
                    className="tabular fill-fg-3 text-2xs"
                  >
                    {labels[i]}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {activeDatum && active !== null && (
        <ChartTooltip x={MARGIN.left + active * band + band / 2} y={MARGIN.top} width={width}>
          {activeDatum.tooltip}
        </ChartTooltip>
      )}
    </div>
  );
}
