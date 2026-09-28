/**
 * The chart container: title, legend, and the table-view twin every chart carries. Tooltips
 * enhance; the table is how every value stays reachable without hovering.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from '../ui/cx.ts';

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'bar' | 'line';
  icon?: ReactNode;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          {item.shape === 'line' ? (
            <span
              aria-hidden
              className="inline-block h-0.5 w-3.5 rounded-full"
              style={{ background: item.color }}
            />
          ) : (
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-[2px]"
              style={{ background: item.color }}
            />
          )}
          {item.icon}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function ChartFrame({
  title,
  description,
  legend,
  chart,
  table,
  className,
  pending,
}: {
  title: string;
  description?: ReactNode;
  legend?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  className?: string;
  /** Refetching: keep the previous render, dimmed, instead of flashing a skeleton. */
  pending?: boolean;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <figure
      className={cx('flex min-w-0 flex-col rounded-lg border border-line bg-panel', className)}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 pt-3">
        <figcaption className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">{title}</div>
          {description && <div className="text-xs text-fg-3">{description}</div>}
        </figcaption>
        <button
          type="button"
          onClick={() => setView((v) => (v === 'chart' ? 'table' : 'chart'))}
          aria-pressed={view === 'table'}
          className="rounded-sm px-1.5 py-0.5 text-xs text-fg-3 hover:bg-hover hover:text-fg"
        >
          {view === 'chart' ? 'Table' : 'Chart'}
        </button>
      </div>
      {legend && view === 'chart' && <div className="px-4 pt-2">{legend}</div>}
      <div className={cx('min-w-0 px-2 pt-2 pb-3 transition-opacity', pending && 'opacity-60')}>
        {view === 'chart' ? chart : <div className="max-h-72 overflow-auto px-2">{table}</div>}
      </div>
    </figure>
  );
}

/** Tooltip box positioned inside a chart (content is plain text nodes — labels are data). */
export function ChartTooltip({
  x,
  y,
  width,
  children,
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
}) {
  const flip = x > width - 180;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-36 rounded-md border border-line bg-raised px-2.5 py-2 text-xs shadow-pop"
      style={{
        left: flip ? undefined : x + 12,
        right: flip ? width - x + 12 : undefined,
        top: Math.max(0, y - 8),
      }}
    >
      {children}
    </div>
  );
}

export function TooltipRow({
  color,
  shape = 'bar',
  label,
  value,
}: {
  color?: string;
  shape?: 'bar' | 'line';
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      {color && (
        <span
          aria-hidden
          className={shape === 'line' ? 'h-0.5 w-3 rounded-full' : 'h-2 w-2 rounded-[2px]'}
          style={{ background: color }}
        />
      )}
      <span className="tabular font-semibold text-fg">{value}</span>
      <span className="text-fg-3">{label}</span>
    </div>
  );
}

export function DataTable({
  columns,
  rows,
}: {
  columns: Array<{ label: string; align?: 'right' }>;
  rows: ReactNode[][];
}) {
  return (
    <table className="w-full text-xs">
      <thead className="text-fg-3">
        <tr>
          {columns.map((c) => (
            <th
              key={c.label}
              scope="col"
              className={cx(
                'py-1.5 pr-3 font-medium',
                c.align === 'right' ? 'text-right' : 'text-left',
              )}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <tr key={i} className="border-t border-line">
            {row.map((cell, j) => (
              <td
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                key={j}
                className={cx('py-1.5 pr-3', columns[j]?.align === 'right' && 'tabular text-right')}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
