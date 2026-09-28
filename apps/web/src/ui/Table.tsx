/**
 * Data tables. Rows that open a detail view contain a real link in their first cell (keyboard
 * and screen-reader accessible); clicking anywhere else on the row follows the same link.
 */
import type { MouseEvent, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { useNavigate } from 'react-router';
import { cx } from './cx.ts';

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-line text-left text-xs text-fg-3">
      <tr>{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  align = 'left',
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={cx(
        'h-9 px-3 font-medium whitespace-nowrap first:pl-4 last:pr-4',
        align === 'right' && 'text-right',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  align = 'left',
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <td
      className={cx(
        'h-10 px-3 align-middle first:pl-4 last:pr-4',
        align === 'right' && 'tabular text-right whitespace-nowrap',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/** A table row; with `to`, the whole row navigates there on click. */
export function TR({
  children,
  to,
  selected,
  onMouseEnter,
  className,
}: {
  children: ReactNode;
  to?: string;
  selected?: boolean;
  onMouseEnter?: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const onClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!to) return;
    const target = event.target as HTMLElement;
    // Let real controls (links, buttons, checkboxes) handle their own clicks.
    if (target.closest('a, button, input, label, select')) return;
    if (window.getSelection()?.toString()) return;
    if (event.metaKey || event.ctrlKey) window.open(to, '_blank', 'noopener');
    else navigate(to);
  };
  return (
    <tr
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      aria-selected={selected || undefined}
      className={cx(
        'border-b border-line last:border-b-0',
        to && 'cursor-pointer hover:bg-hover',
        selected && 'bg-selected',
        className,
      )}
    >
      {children}
    </tr>
  );
}

/** "Load more" footer for keyset-paginated lists. */
export function MoreRows({
  hasMore,
  loading,
  onMore,
  shown,
  noun,
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  shown: number;
  noun: string;
}) {
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-fg-3">
      <span className="tabular">
        {shown.toLocaleString('en-US')} {noun}
        {hasMore ? ' shown' : ''}
      </span>
      {hasMore && (
        <button
          type="button"
          onClick={onMore}
          disabled={loading}
          className="rounded-md px-2 py-1 font-medium text-accent-fg hover:bg-hover disabled:opacity-60"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
