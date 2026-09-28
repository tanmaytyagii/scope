import { padEnd, padStart, truncate, visibleLength } from './style.ts';

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
  /** Maximum width; longer values are truncated with an ellipsis. */
  max?: number;
}

/** Renders rows as an aligned table with a dim header, for terminal output. */
export function renderTable<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  dim: (s: string) => string,
  indent = '  ',
): string {
  const cells = rows.map((row) =>
    columns.map((c) => (c.max ? truncate(c.value(row), c.max) : c.value(row))),
  );
  const widths = columns.map((c, i) =>
    Math.max(visibleLength(c.header), ...cells.map((r) => visibleLength(r[i] ?? ''))),
  );
  const line = (values: string[]) =>
    indent +
    values
      .map((v, i) => {
        const w = widths[i] ?? 0;
        const last = i === values.length - 1;
        if (columns[i]?.align === 'right') return padStart(v, w);
        return last ? v : padEnd(v, w);
      })
      .join('  ')
      .trimEnd();
  return [dim(line(columns.map((c) => c.header))), ...cells.map(line)].join('\n');
}
