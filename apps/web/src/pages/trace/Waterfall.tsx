/**
 * The span tree with a timing waterfall: what ran, in what order, nested how, and for how long.
 * A keyboard-operable tree (ARIA treeview with roving focus): ↑↓ move, ←→ collapse/expand.
 * Bars: accent for the workflow's own spans, neutral for evaluation work (which is not part of
 * the workflow's latency), status red for spans that errored.
 */
import type { Span } from '@scope-ai/protocol';
import { type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import { formatDuration } from '../../lib/format.ts';
import { layoutWaterfall, timeTicks } from '../../lib/spans.ts';
import { cx } from '../../ui/cx.ts';
import { Bolt, ChevronDown, ChevronRight } from '../../ui/icons.tsx';
import { SpanKindTag } from '../../ui/Kind.tsx';

export function Waterfall({
  spans,
  selected,
  onSelect,
  collapsed,
  onToggle,
  filtered,
}: {
  spans: Span[];
  selected: string | null;
  /** `reveal` is set for pointer selection, so small screens can scroll to the details. */
  onSelect: (id: string, reveal?: boolean) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string, open?: boolean) => void;
  /** A span filter's result: only these rows show, and rows shown only as context are muted. */
  filtered?: { matched: ReadonlySet<string>; visible: ReadonlySet<string> } | null;
}) {
  // While filtering, every match is shown, even inside collapsed spans.
  const { rows, totalMs } = useMemo(
    () => layoutWaterfall(spans, filtered ? new Set() : collapsed, filtered?.visible),
    [spans, collapsed, filtered],
  );
  const ticks = useMemo(() => timeTicks(totalMs, 3), [totalMs]);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const index = Math.max(
    0,
    rows.findIndex((r) => r.span.id === selected),
  );

  useEffect(() => {
    if (selected && document.activeElement?.closest('[role="tree"]'))
      rowRefs.current.get(selected)?.focus();
  }, [selected]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[index];
    if (!row) return;
    const move = (i: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (target) onSelect(target.span.id);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      // While filtering, nothing collapses: left goes to the parent, right to the first child.
      case 'ArrowRight':
        if (!filtered && row.childCount > 0 && collapsed.has(row.span.id))
          onToggle(row.span.id, true);
        else if (row.childCount > 0) move(index + 1);
        break;
      case 'ArrowLeft':
        if (!filtered && row.childCount > 0 && !collapsed.has(row.span.id))
          onToggle(row.span.id, false);
        else if (row.span.parentId) onSelect(row.span.parentId);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="min-w-0">
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] border-b border-line text-2xs text-fg-3 lg:grid-cols-[minmax(0,4fr)_minmax(0,3fr)]">
        <div className="px-4 py-2">Span</div>
        <div className="relative mr-4 h-8" aria-hidden>
          {ticks.map((t, i) => (
            <span
              key={t}
              className={cx(
                'tabular absolute top-2 whitespace-nowrap',
                i === 0
                  ? ''
                  : i === ticks.length - 1 && t / (totalMs || 1) > 0.9
                    ? '-translate-x-full'
                    : '-translate-x-1/2',
              )}
              style={{ left: `${Math.min(1, t / (totalMs || 1)) * 100}%` }}
            >
              {t === 0 ? '0' : formatDuration(t)}
            </span>
          ))}
        </div>
      </div>
      <div role="tree" aria-label="Spans" onKeyDown={onKey} className="py-1">
        {rows.map((row, i) => {
          const { span } = row;
          const isSelected = span.id === selected;
          const context = filtered ? !filtered.matched.has(span.id) : false;
          const open = row.childCount > 0 && (filtered ? true : !collapsed.has(span.id));
          const color =
            span.status === 'error'
              ? 'var(--bad)'
              : row.inEvaluation
                ? 'var(--neutral-mark)'
                : 'var(--series-1)';
          return (
            <div
              key={span.id}
              ref={(el) => {
                if (el) rowRefs.current.set(span.id, el);
                else rowRefs.current.delete(span.id);
              }}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={row.childCount > 0 ? open : undefined}
              aria-label={`${span.name}, ${span.kind}, ${formatDuration(span.durationMs)}${span.status === 'error' ? ', error' : ''}`}
              tabIndex={isSelected || (!selected && i === 0) ? 0 : -1}
              onClick={() => onSelect(span.id, true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(span.id);
                }
              }}
              className={cx(
                'grid cursor-pointer grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center outline-none lg:grid-cols-[minmax(0,4fr)_minmax(0,3fr)]',
                'focus-visible:bg-selected focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                isSelected ? 'bg-selected' : 'hover:bg-hover',
              )}
            >
              <div
                className="flex h-8 min-w-0 items-center gap-1.5 pr-3 pl-4"
                style={{ paddingLeft: 16 + row.depth * 14 }}
              >
                {row.childCount > 0 && !filtered ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={open ? `Collapse ${span.name}` : `Expand ${span.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(span.id);
                    }}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
                  >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                ) : (
                  <span className="w-5 shrink-0" />
                )}
                <SpanKindTag kind={span.kind} />
                <span
                  className={cx(
                    'min-w-0 truncate text-sm',
                    context ? 'text-fg-2' : 'text-fg',
                    isSelected && 'font-medium',
                  )}
                  title={
                    span.model
                      ? `${span.name} · ${span.provider ? `${span.provider}:` : ''}${span.model}`
                      : span.name
                  }
                >
                  {span.name}
                </span>
                {span.status === 'error' && (
                  <Bolt size={12} className="shrink-0 text-bad-fg" label="error" />
                )}
                <span className="tabular ml-auto shrink-0 pl-2 text-xs text-fg-2">
                  {formatDuration(span.durationMs)}
                </span>
              </div>
              <div className="relative mr-4 h-8" aria-hidden>
                {ticks.map((t) => (
                  <span
                    key={t}
                    className="absolute inset-y-0 w-px bg-grid"
                    style={{ left: `${(t / (totalMs || 1)) * 100}%` }}
                  />
                ))}
                <span
                  className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[3px]"
                  style={{
                    left: `${row.left * 100}%`,
                    width: `max(2px, ${row.width * 100}%)`,
                    background: color,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
