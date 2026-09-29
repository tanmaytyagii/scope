/** Durations written as people write them on a command line: 90m, 24h, 30d, 2w. */

const UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** Milliseconds in `text` ("30d", "12h", "90m", "2w"), or null when it is not a duration. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*([mhdw])$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  const value = Number(m[1]);
  const unit = UNITS[m[2] as string] as number;
  return Number.isSafeInteger(value * unit) ? value * unit : null;
}

/**
 * A point in time given as a duration before `now` ("7d") or as an ISO date ("2026-09-01"),
 * in epoch milliseconds; null when it is neither.
 */
export function parseCutoff(text: string, now = Date.now()): number | null {
  const duration = parseDuration(text);
  if (duration !== null) return now - duration;
  if (!/^\d{4}-\d{2}-\d{2}/.test(text.trim())) return null;
  const date = Date.parse(text.trim());
  return Number.isNaN(date) ? null : date;
}
