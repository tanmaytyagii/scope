/**
 * Model pricing and cost estimation.
 *
 * Prices are USD per one million tokens. Every entry records when and where the price was
 * taken from, because prices change and SCOPE must never present a stale number as a fact.
 * Projects override or extend this table in scope.yaml (`pricing:`). A model with no known
 * price yields `null` cost — never zero.
 */
import type { Usage } from './model.ts';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M tokens read from a prompt cache. Defaults to `input`. */
  cacheRead?: number;
  /** USD per 1M tokens written to a prompt cache. Defaults to `input`. */
  cacheWrite?: number;
  /** ISO date the price was recorded. */
  asOf: string;
  source: string;
}

const ANTHROPIC_SOURCE = 'https://www.anthropic.com/pricing';
const ANTHROPIC_AS_OF = '2026-06-24';
// Checked against this page on 2026-09-30: unchanged since the 2025-08-07 entries.
const OPENAI_SOURCE = 'https://developers.openai.com/api/docs/pricing';
const OPENAI_AS_OF = '2026-09-30';

/** Derived prices are rounded so they read as the published figures (3 × 0.1 is not 0.30000000000000004). */
const perMillion = (usd: number) => Math.round(usd * 1e6) / 1e6;

function anthropic(input: number, output: number, cacheRead?: number): ModelPrice {
  return {
    input,
    output,
    cacheRead: cacheRead ?? perMillion(input * 0.1),
    cacheWrite: perMillion(input * 1.25),
    asOf: ANTHROPIC_AS_OF,
    source: ANTHROPIC_SOURCE,
  };
}

function openai(input: number, output: number, cacheRead?: number): ModelPrice {
  const price: ModelPrice = { input, output, asOf: OPENAI_AS_OF, source: OPENAI_SOURCE };
  if (cacheRead !== undefined) price.cacheRead = cacheRead;
  return price;
}

/** Built-in prices, keyed by `provider:model`. */
export const BUILTIN_PRICES: Readonly<Record<string, ModelPrice>> = {
  'anthropic:claude-fable-5-1': anthropic(10, 50, 0.25),
  'anthropic:claude-fable-5': anthropic(10, 50),
  'anthropic:claude-opus-5-5': anthropic(4, 20, 0.2),
  'anthropic:claude-opus-5': anthropic(5, 25),
  'anthropic:claude-opus-4-8': anthropic(5, 25),
  'anthropic:claude-opus-4-7': anthropic(5, 25),
  'anthropic:claude-opus-4-6': anthropic(5, 25),
  'anthropic:claude-sonnet-5': anthropic(2, 10),
  'anthropic:claude-sonnet-4-6': anthropic(3, 15),
  'anthropic:claude-haiku-4-5': anthropic(1, 5),
  'openai:gpt-5': openai(1.25, 10, 0.125),
  'openai:gpt-5-mini': openai(0.25, 2, 0.025),
  'openai:gpt-5-nano': openai(0.05, 0.4, 0.005),
  'openai:gpt-4.1': openai(2, 8, 0.5),
  'openai:gpt-4.1-mini': openai(0.4, 1.6, 0.1),
  'openai:gpt-4.1-nano': openai(0.1, 0.4, 0.025),
  'openai:gpt-4o': openai(2.5, 10, 1.25),
  'openai:gpt-4o-mini': openai(0.15, 0.6, 0.075),
  'openai:o3': openai(2, 8, 0.5),
  'openai:o4-mini': openai(1.1, 4.4, 0.275),
  'openai:text-embedding-3-small': openai(0.02, 0),
  'openai:text-embedding-3-large': openai(0.13, 0),
};

/** Providers whose models are free by construction (local, deterministic). */
const FREE_PROVIDERS = new Set(['local']);

export interface PriceLookup {
  price: ModelPrice | null;
  /** The table key that matched, e.g. "openai:gpt-5". */
  key: string | null;
  free: boolean;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * Finds the price for a provider/model pair. Exact matches win; otherwise a dated snapshot
 * such as `gpt-4o-2024-08-06` matches its base entry `gpt-4o`.
 */
export function lookupPrice(
  provider: string,
  model: string,
  overrides: PriceTable = {},
): PriceLookup {
  if (FREE_PROVIDERS.has(provider)) return { price: null, key: null, free: true };
  const tables = [overrides, BUILTIN_PRICES];
  const key = `${provider}:${model}`;
  for (const table of tables) {
    const exact = table[key];
    if (exact) return { price: exact, key, free: false };
  }
  // Snapshot suffixes: -2024-08-06, -20250514, @20251101
  const base = model.replace(/(?:-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8})$/, '');
  if (base !== model) {
    const baseKey = `${provider}:${base}`;
    for (const table of tables) {
      const entry = table[baseKey];
      if (entry) return { price: entry, key: baseKey, free: false };
    }
  }
  return { price: null, key: null, free: false };
}

export interface CostEstimate {
  usd: number | null;
  /** Table key used, for provenance. */
  priceKey: string | null;
  asOf: string | null;
}

export function estimateCost(
  provider: string,
  model: string,
  usage: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
  overrides: PriceTable = {},
): CostEstimate {
  const lookup = lookupPrice(provider, model, overrides);
  if (lookup.free) return { usd: 0, priceKey: null, asOf: null };
  if (!lookup.price) return { usd: null, priceKey: null, asOf: null };
  const p = lookup.price;
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) +
      (usage.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input)) /
    1_000_000;
  return { usd, priceKey: lookup.key, asOf: p.asOf };
}

/** Prices older than this are shown as possibly out of date: providers change them. */
export const PRICE_REVIEW_DAYS = 180;

/** Days since a price was recorded (its `asOf` date), or null when the date is unreadable. */
export function priceAgeDays(asOf: string, now: number = Date.now()): number | null {
  const recorded = Date.parse(asOf);
  if (Number.isNaN(recorded)) return null;
  return Math.max(0, Math.floor((now - recorded) / 86_400_000));
}

/** Whether a price is old enough that it may no longer be what the provider charges. */
export function isPriceStale(asOf: string, now: number = Date.now()): boolean {
  const age = priceAgeDays(asOf, now);
  return age !== null && age > PRICE_REVIEW_DAYS;
}
