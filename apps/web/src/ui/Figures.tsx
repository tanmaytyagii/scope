/**
 * Numbers as the form: stat tiles, meters and page headers. A stat tile is the right form for a
 * single current value; a meter for one ratio against its limit.
 */
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export function PageHeader({
  title,
  meta,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end gap-x-6 gap-y-3 pb-5">
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="mb-1 text-xs text-fg-3">{eyebrow}</div>}
        <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold tracking-tight text-fg">
          {title}
        </h1>
        {meta && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-2">
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function StatTile({
  label,
  value,
  sub,
  trend,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  trend?: ReactNode;
  tone?: 'bad' | 'warn';
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-panel px-4 py-3.5">
      <div className="text-xs text-fg-3">{label}</div>
      <div
        className={cx(
          'text-2xl leading-8 font-semibold tracking-tight',
          tone === 'bad' ? 'text-bad-fg' : tone === 'warn' ? 'text-warn-fg' : 'text-fg',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-fg-2">{sub}</div>}
      {trend && <div className="mt-1">{trend}</div>}
    </div>
  );
}

/** A row of stat tiles separated by hairlines. */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'grid gap-px overflow-hidden rounded-lg border border-line bg-line',
        // Five tiles: two per row below xl, with the fifth spanning its row (no empty cell).
        'grid-cols-2 xl:grid-cols-5 [&>*:nth-child(5):last-child]:col-span-2 xl:[&>*:nth-child(5):last-child]:col-span-1',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One ratio against a full track (same-hue track, so the whole bar reads as one scale). */
export function Meter({
  value,
  label,
  width = 64,
}: {
  value: number | null;
  label: string;
  width?: number;
}) {
  if (value === null) return <span className="text-fg-3">—</span>;
  const pct = Math.max(0, Math.min(1, value));
  return (
    <span className="inline-flex items-center gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled consistently across browsers */}
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 1000) / 10}
        className="relative inline-block h-1.5 overflow-hidden rounded-full bg-meter-track"
        style={{ width }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${pct * 100}%` }}
        />
      </span>
      <span className="tabular w-12 text-right text-sm">{(pct * 100).toFixed(1)}%</span>
    </span>
  );
}

/** A horizontal data bar inside a table cell, scaled to the column's maximum. */
export function CellBar({
  value,
  max,
  children,
}: {
  value: number;
  max: number;
  children: ReactNode;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className="inline-flex w-full items-center justify-end gap-2">
      <span className="tabular">{children}</span>
      <span
        aria-hidden
        className="relative inline-block h-1.5 w-16 shrink-0 rounded-full bg-sunken"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${Math.max(pct * 100, value > 0 ? 3 : 0)}%` }}
        />
      </span>
    </span>
  );
}
