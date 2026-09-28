/**
 * Okapi BM25 ranking over short documents. Used by the built-in retriever and by the offline
 * `local:extractive` model. Deterministic: ties are broken by document order.
 */
import { terms } from './text.ts';

export interface Bm25Options {
  /** Term-frequency saturation. */
  k1?: number;
  /** Length normalization. */
  b?: number;
}

export interface Bm25Hit {
  index: number;
  score: number;
  /** Query terms found in the document. */
  matched: string[];
}

export interface Bm25Index {
  readonly size: number;
  search(query: string, limit?: number): Bm25Hit[];
}

export function createBm25Index(
  documents: readonly string[],
  options: Bm25Options = {},
): Bm25Index {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const termFreqs: Array<Map<string, number>> = [];
  const lengths: number[] = [];
  const docFreq = new Map<string, number>();

  for (const doc of documents) {
    const tokens = terms(doc);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    termFreqs.push(tf);
    lengths.push(tokens.length);
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const n = documents.length;
  const avgLength = n === 0 ? 0 : lengths.reduce((a, c) => a + c, 0) / n;

  const idf = (term: string): number => {
    const df = docFreq.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };

  return {
    size: n,
    search(query, limit = 10) {
      const queryTerms = [...new Set(terms(query))];
      if (queryTerms.length === 0 || n === 0) return [];
      const hits: Bm25Hit[] = [];
      for (let i = 0; i < n; i++) {
        const tf = termFreqs[i] as Map<string, number>;
        const len = lengths[i] as number;
        let score = 0;
        const matched: string[] = [];
        for (const term of queryTerms) {
          const f = tf.get(term);
          if (!f) continue;
          matched.push(term);
          const norm = avgLength === 0 ? 1 : 1 - b + b * (len / avgLength);
          score += idf(term) * ((f * (k1 + 1)) / (f + k1 * norm));
        }
        if (score > 0) hits.push({ index: i, score, matched });
      }
      hits.sort((x, y) => y.score - x.score || x.index - y.index);
      return hits.slice(0, Math.max(0, limit));
    },
  };
}
