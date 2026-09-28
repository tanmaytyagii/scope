/**
 * Line chart over ordered x positions. 2px lines with round joins; a crosshair snaps to the
 * nearest x and the tooltip lists every series there. Gaps in the data stay gaps; isolated
 * points are drawn as dots so they are not invisible. Series end in direct labels when they
 * do not collide (the legend is always present for two or more series).
 */
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { ChartTooltip, TooltipRow, useWidth } from './Frame.tsx';
import { axisLabels, nearestIndex, niceTicks } from './scale.ts';

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
}

const MARGIN = { top: 12, right: 44, bottom: 24, left: 52 };

export function Lines({
  x,
  series,
  height = 180,
  yFormat,
  xFormat,
  ariaLabel,
  tooltipTitle,
}: {
  x: string[];
  series: LineSeries[];
  height?: number;
  yFormat: (value: number) => string;
  xFormat: (x: string) => string;
  ariaLabel: string;
  tooltipTitle?: (x: string) => ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.max(...all, 0), 4);
  const top = ticks[ticks.length - 1] ?? 1;
  const n = x.length;
  const px = (i: number) => MARGIN.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const py = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
  const centers = x.map((_, i) => px(i));
  const labels = axisLabels(
    x.map((v) => xFormat(v)),
    n > 1 ? plotW / (n - 1) : plotW,
  );

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return;
    const current = active ?? n - 1;
    if (e.key === 'ArrowRight') setActive(Math.min(n - 1, current + 1));
    else if (e.key === 'ArrowLeft') setActive(Math.max(0, current - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else return;
    e.preventDefault();
  };

  // End labels: at each series' last value, unless two would overlap.
  const ends = series
    .map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && s.values[i] === null) i--;
      return i >= 0 ? { s, i, y: py(s.values[i] as number) } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  const endLabelsFit = ends.every((a, i) =>
    ends.every((b, j) => i === j || Math.abs(a.y - b.y) >= 12),
  );

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
          onFocus={() => setActive((a) => a ?? n - 1)}
          onBlur={() => setActive(null)}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setActive(nearestIndex(centers, e.clientX - rect.left));
          }}
          onPointerLeave={() => setActive(null)}
          className="block rounded-sm"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={py(t)}
                y2={py(t)}
                stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'}
                shapeRendering="crispEdges"
              />
              <text
                x={MARGIN.left - 8}
                y={py(t)}
                dy="0.32em"
                textAnchor="end"
                className="tabular fill-fg-3 text-2xs"
              >
                {yFormat(t)}
              </text>
            </g>
          ))}
          {labels.map((label, i) =>
            label === null ? null : (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat; position is the identity
                key={i}
                x={px(i)}
                y={height - 6}
                textAnchor="middle"
                className="tabular fill-fg-3 text-2xs"
              >
                {label}
              </text>
            ),
          )}
          {active !== null && (
            <line
              x1={px(active)}
              x2={px(active)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
              stroke="var(--axis)"
              shapeRendering="crispEdges"
            />
          )}
          {series.map((s) => {
            const segments: string[] = [];
            const singles: number[] = [];
            let run: number[] = [];
            const flush = () => {
              if (run.length === 1) singles.push(run[0] as number);
              else if (run.length > 1)
                segments.push(
                  run
                    .map((i, k) => `${k ? 'L' : 'M'}${px(i)},${py(s.values[i] as number)}`)
                    .join(' '),
                );
              run = [];
            };
            s.values.forEach((v, i) => {
              if (v === null) flush();
              else run.push(i);
            });
            flush();
            return (
              <g key={s.id}>
                {segments.map((d) => (
                  <path
                    key={d}
                    d={d}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
                {singles.map((i) => (
                  <circle key={i} cx={px(i)} cy={py(s.values[i] as number)} r={3} fill={s.color} />
                ))}
                {active !== null && s.values[active] !== null && s.values[active] !== undefined && (
                  <circle
                    cx={px(active)}
                    cy={py(s.values[active] as number)}
                    r={4}
                    fill={s.color}
                    stroke="var(--panel)"
                    strokeWidth={2}
                  />
                )}
              </g>
            );
          })}
          {endLabelsFit &&
            series.length > 1 &&
            ends.map((e) => (
              <text key={e.s.id} x={px(e.i) + 8} y={e.y} dy="0.32em" className="fill-fg-2 text-2xs">
                {e.s.label}
              </text>
            ))}
        </svg>
      )}
      {active !== null && x[active] !== undefined && (
        <ChartTooltip x={px(active)} y={MARGIN.top} width={width}>
          <div className="mb-1 text-fg-3">
            {tooltipTitle ? tooltipTitle(x[active] as string) : xFormat(x[active] as string)}
          </div>
          {series.map((s) => (
            <TooltipRow
              key={s.id}
              shape="line"
              color={s.color}
              label={s.label}
              value={
                s.values[active] === null || s.values[active] === undefined
                  ? 'no data'
                  : yFormat(s.values[active] as number)
              }
            />
          ))}
        </ChartTooltip>
      )}
    </div>
  );
}
