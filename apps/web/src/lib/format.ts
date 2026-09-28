/**
 * Display formatting. Numbers use the same functions as the CLI (from @scope-ai/core), so a
 * value reads identically in the terminal and the dashboard.
 */
import { formatRelativeTime, formatUsd } from '@scope-ai/core';

export {
  formatDelta,
  formatDuration,
  formatMetric,
  formatNumber,
  formatPercent,
  formatScore,
  formatTokens,
  formatUsd,
  pluralize,
  shortId,
} from '@scope-ai/core';

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const hourMinute = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateTime.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return dateOnly.format(new Date(iso));
}

export function formatHour(iso: string): string {
  return hourMinute.format(new Date(iso));
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  return formatRelativeTime(Date.parse(iso), now);
}

/** Estimated cost, or "unknown" when a model's price is unknown — never a misleading $0. */
export function formatCost(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? 'unknown' : formatUsd(usd);
}

/** A price per 1M tokens as published: "$0.3", "$12.5" — no float noise, no forced decimals. */
export function formatPrice(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  return `$${Number(usd.toPrecision(6))}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
