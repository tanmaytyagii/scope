/**
 * Text processing shared by retrieval, heuristic evaluators and the local models.
 *
 * Everything here is deterministic and language-light (English stopwords and a conservative
 * suffix stemmer). Heuristic evaluators built on these functions say so in their output.
 */

export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being ' +
    'below between both but by can could did do does doing down during each few for from further ' +
    'had has have having he her here hers herself him himself his how i if in into is it its itself ' +
    'just me more most my myself no nor not now of off on once only or other our ours ourselves out ' +
    'over own same she should so some such than that the their theirs them themselves then there ' +
    'these they this those through to too under until up very was we were what when where which ' +
    'while who whom why will with would you your yours yourself yourselves also may might must ' +
    "shall us via per within without i'm you're it's don't can't won't isn't aren't please"
  ).split(/\s+/),
);

/** Conservative English suffix stripping, enough to match "refunds"/"refund", "shipped"/"ship". */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('ss')) return word;
  if (word.endsWith('ing') && word.length > 5) return undouble(word.slice(0, -3));
  if (word.endsWith('ed') && word.length > 4) return undouble(word.slice(0, -2));
  if (word.endsWith('es') && /(?:x|ch|sh|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
}

function undouble(word: string): string {
  return /([bdfgklmnprt])\1$/.test(word) ? word.slice(0, -1) : word;
}

export interface TokenizeOptions {
  stopwords?: boolean;
  stem?: boolean;
}

/** Lowercased word tokens. Numbers are kept intact (including decimals like 3.5 and 1,200). */
export function words(text: string): string[] {
  const matches = text.toLowerCase().match(/\d+(?:[.,]\d+)*%?|[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu);
  return matches ? matches.map((w) => w.replace(/’/g, "'")) : [];
}

/** Content terms for matching: lowercased, stopwords removed, stemmed. */
export function terms(text: string, options: TokenizeOptions = {}): string[] {
  const dropStop = options.stopwords ?? true;
  const doStem = options.stem ?? true;
  const out: string[] = [];
  for (const w of words(text)) {
    if (dropStop && STOPWORDS.has(w)) continue;
    out.push(doStem ? stem(w) : w);
  }
  return out;
}

const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'inc',
  'ltd',
  'co',
  'no',
  'approx',
  'st',
]);

/**
 * Splits text into sentences. Handles decimals, common abbreviations, bullet lists and
 * line-separated items. Markdown headings and list markers are stripped from the result.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').trim();
    if (!line) continue;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      const next = line[i + 1];
      if (next !== undefined && next !== ' ' && next !== '"' && next !== "'" && next !== ')')
        continue;
      if (ch === '.') {
        const before = line.slice(start, i);
        const lastWord = before.split(/\s+/).pop()?.toLowerCase() ?? '';
        if (ABBREVIATIONS.has(lastWord.replace(/\.$/, ''))) continue;
        if (/\b[A-Z]$/.test(before)) continue; // initials like "J."
      }
      const sentence = line.slice(start, i + 1).trim();
      if (sentence) out.push(sentence);
      start = i + 1;
    }
    const rest = line.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = curr;
  }
  return prev[b.length] as number;
}

/** Returns the closest candidate for a likely typo, or undefined when nothing is close. */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  const needle = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    // Treat "uppercase" → "upper" and "temp" → "temperature" as near misses.
    const prefix =
      Math.min(needle.length, c.length) >= 3 && (needle.startsWith(c) || c.startsWith(needle));
    const d = prefix ? 1 : levenshtein(needle, c);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  const limit = Math.max(2, Math.floor(needle.length / 3));
  return best !== undefined && bestDistance <= limit ? best : undefined;
}

/**
 * Rough token estimate (~4 characters per token for English). Used only for local models and
 * always marked as estimated.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}
