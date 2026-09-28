/** Small, dependency-free statistics helpers. All functions ignore non-finite values. */

function finite(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) if (Number.isFinite(v)) total += v;
  return total;
}

export function mean(values: readonly number[]): number | null {
  const xs = finite(values);
  return xs.length === 0 ? null : sum(xs) / xs.length;
}

export function max(values: readonly number[]): number | null {
  const xs = finite(values);
  return xs.length === 0 ? null : Math.max(...xs);
}

/**
 * Percentile using linear interpolation between closest ranks (the "R-7" method used by
 * NumPy and most spreadsheets). `p` is in [0, 100].
 */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = finite(values).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0] as number;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (xs.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lo = xs[lower] as number;
  const hi = xs[upper] as number;
  return lo + (hi - lo) * (rank - lower);
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Rounds to a fixed number of decimal places without floating-point noise in output. */
export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
