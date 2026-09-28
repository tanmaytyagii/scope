/**
 * Heuristic evaluators: deterministic approximations of fuzzy properties.
 *
 * They are useful signals and good regression detectors, but they are not verdicts. Each one
 * documents its method and its known failure modes, and reports its evidence.
 */
import {
  asText,
  isJsonObject,
  type JsonValue,
  sentences,
  stem,
  terms,
  words,
} from '@scope-ai/core';
import { z } from 'zod';
import { defineEvaluator, type EvaluatorOutcome } from './types.ts';

/** Sentences that decline to answer are not claims and cannot be "ungrounded". */
export const ABSTENTION =
  /\b(?:i (?:do not|don't|could not|couldn't|cannot|can't) (?:find|know|answer|determine|see)|(?:is|are|was) not (?:mentioned|provided|available|specified|covered) in the (?:context|documents?|sources?|information)|not enough information)\b/i;

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ─── similarity ──────────────────────────────────────────────────────────────────────────────

const ARTICLES = new Set(['a', 'an', 'the']);

function similarityTokens(text: string): string[] {
  return words(text)
    .filter((w) => !ARTICLES.has(w))
    .map(stem);
}

export function tokenF1(prediction: string, reference: string): number {
  const pred = similarityTokens(prediction);
  const ref = similarityTokens(reference);
  if (pred.length === 0 && ref.length === 0) return 1;
  if (pred.length === 0 || ref.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of ref) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of pred) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  if (common === 0) return 0;
  const precision = common / pred.length;
  const recall = common / ref.length;
  return (2 * precision * recall) / (precision + recall);
}

export function rougeL(prediction: string, reference: string): number {
  const a = similarityTokens(prediction);
  const b = similarityTokens(reference);
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    prev = curr;
  }
  const lcs = prev[b.length] as number;
  if (lcs === 0) return 0;
  const precision = lcs / a.length;
  const recall = lcs / b.length;
  return (2 * precision * recall) / (precision + recall);
}

export const similarity = defineEvaluator({
  type: 'similarity',
  kind: 'heuristic',
  description:
    'Lexical overlap with the expected answer (token F1 or ROUGE-L). Measures shared wording, not meaning: paraphrases score low.',
  requires: ['expected'],
  defaultThreshold: 0.5,
  argsSchema: z.strictObject({ method: z.enum(['token_f1', 'rouge_l']).default('token_f1') }),
  evaluate({ output, expected, args }): EvaluatorOutcome {
    if (expected === null)
      return {
        score: null,
        skipped: true,
        reason: 'The case has no expected value to compare against.',
      };
    const references = Array.isArray(expected)
      ? expected.map((e) => asText(e))
      : [asText(expected)];
    const fn = args.method === 'rouge_l' ? rougeL : tokenF1;
    const scores = references.map((r) => fn(asText(output), r));
    const best = Math.max(...scores);
    return {
      score: best,
      reason: `${args.method === 'rouge_l' ? 'ROUGE-L' : 'Token F1'} ${best.toFixed(2)} against ${references.length === 1 ? 'the expected answer' : `the closest of ${references.length} references`}.`,
      metadata: { method: args.method },
    };
  },
});

// ─── groundedness ────────────────────────────────────────────────────────────────────────────

export const groundedness = defineEvaluator({
  type: 'groundedness',
  kind: 'heuristic',
  description:
    'Share of answer sentences whose content words appear in the context (lexical support). Misses paraphrased support and cannot detect contradictions that reuse context words.',
  requires: ['context'],
  defaultThreshold: 0.8,
  argsSchema: z.strictObject({
    /** Fraction of a sentence's content words that must appear in one context passage. */
    support_threshold: z.number().min(0).max(1).default(0.6),
    /** Sentences with fewer content words are too short to judge and are ignored. */
    min_terms: z.number().int().min(1).default(3),
  }),
  evaluate({ output, context, args }): EvaluatorOutcome {
    if (!context) {
      return {
        score: null,
        skipped: true,
        reason: 'No context to check against. Add a retrieve step or set `with.context`.',
      };
    }
    const contextSentences = sentences(context);
    // Passages of up to two adjacent sentences, so an answer may combine neighbouring facts.
    const passages: Array<Set<string>> = [];
    for (let i = 0; i < contextSentences.length; i++) {
      passages.push(new Set(terms(contextSentences[i] as string)));
      if (i + 1 < contextSentences.length) {
        passages.push(new Set(terms(`${contextSentences[i]} ${contextSentences[i + 1]}`)));
      }
    }
    let judged = 0;
    let supported = 0;
    let abstained = 0;
    const unsupported: Array<{ sentence: string; support: number }> = [];
    for (const sentence of sentences(asText(output))) {
      if (ABSTENTION.test(sentence)) {
        abstained++;
        continue;
      }
      const sentenceTerms = [...new Set(terms(sentence))];
      if (sentenceTerms.length < args.min_terms) continue;
      judged++;
      let best = 0;
      for (const passage of passages) {
        const hit = sentenceTerms.filter((t) => passage.has(t)).length / sentenceTerms.length;
        if (hit > best) best = hit;
      }
      if (best >= args.support_threshold) supported++;
      else
        unsupported.push({ sentence: truncate(sentence), support: Math.round(best * 100) / 100 });
    }
    if (judged === 0) {
      return {
        score: null,
        skipped: true,
        reason:
          abstained > 0
            ? 'The answer declines to answer; there are no claims to check.'
            : 'The answer is too short to judge.',
        metadata: { judged, abstained },
      };
    }
    const score = supported / judged;
    return {
      score,
      reason:
        unsupported.length === 0
          ? `All ${judged} ${judged === 1 ? 'sentence is' : 'sentences are'} supported by the context.`
          : `${unsupported.length} of ${judged} ${judged === 1 ? 'sentence is' : 'sentences are'} not supported by the context: "${unsupported[0]?.sentence}"${unsupported.length > 1 ? ' …' : ''}`,
      metadata: { method: 'lexical-support', judged, supported, abstained, unsupported },
    };
  },
});

// ─── unsupported claims (hallucination signal) ───────────────────────────────────────────────

const NOT_ENTITIES = new Set([
  'I',
  'The',
  'A',
  'An',
  'This',
  'That',
  'These',
  'Those',
  'It',
  'We',
  'You',
  'Our',
  'Your',
  'If',
  'Yes',
  'No',
  'Please',
  'However',
  'Also',
  'Note',
]);

export interface Claim {
  kind: 'number' | 'entity';
  text: string;
}

/** Extracts checkable specifics: numbers (with units) and capitalized names. */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const add = (kind: Claim['kind'], value: string) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ kind, text: value });
  };
  for (const m of text.matchAll(/(?:[$€£]\s?)?\d+(?:[.,]\d+)*(?:\s?%)?/g))
    add('number', m[0].trim());
  for (const sentence of sentences(text)) {
    const tokens = sentence.split(/\s+/);
    let run: string[] = [];
    const flush = () => {
      if (run.length > 0) add('entity', run.join(' '));
      run = [];
    };
    tokens.forEach((raw, i) => {
      const token = raw.replace(/^[("'“‘]+|[)"'”’.,;:!?]+$/g, '');
      const capitalized = /^[A-Z][a-zA-Z]+$/.test(token) || /^[A-Z]{2,}$/.test(token);
      const sentenceStart = i === 0;
      if (capitalized && !NOT_ENTITIES.has(token) && !(sentenceStart && !/^[A-Z]{2,}$/.test(token)))
        run.push(token);
      else flush();
      if (/[.,;:!?)]$/.test(raw)) flush();
    });
    flush();
  }
  return claims;
}

function numberAppears(claim: string, contextNumbers: Set<string>): boolean {
  const normalized = claim.replace(/[$€£\s%]/g, '').replace(/,(?=\d{3}\b)/g, '');
  return (
    contextNumbers.has(normalized) || contextNumbers.has(String(Number.parseFloat(normalized)))
  );
}

export const unsupportedClaims = defineEvaluator({
  type: 'unsupported_claims',
  kind: 'heuristic',
  description:
    'Flags numbers and names in the answer that never appear in the context — a hallucination signal. Cannot see unsupported claims made in ordinary words, and number words ("five") do not match digits.',
  requires: ['context'],
  defaultThreshold: 1,
  argsSchema: z.strictObject({}),
  evaluate({ output, context }): EvaluatorOutcome {
    if (!context) {
      return {
        score: null,
        skipped: true,
        reason: 'No context to check against. Add a retrieve step or set `with.context`.',
      };
    }
    const claims = extractClaims(asText(output));
    if (claims.length === 0)
      return {
        score: 1,
        reason: 'No specific numbers or names to verify.',
        metadata: { claims: 0, unsupported: [] },
      };
    const lowerContext = context.toLowerCase();
    const contextNumbers = new Set<string>();
    for (const m of context.matchAll(/\d+(?:[.,]\d+)*/g)) {
      const n = m[0].replace(/,(?=\d{3}\b)/g, '');
      contextNumbers.add(n);
      contextNumbers.add(String(Number.parseFloat(n)));
    }
    const unsupported = claims.filter((c) =>
      c.kind === 'number'
        ? !numberAppears(c.text, contextNumbers)
        : !lowerContext.includes(c.text.toLowerCase()),
    );
    const score = 1 - unsupported.length / claims.length;
    return {
      score,
      reason:
        unsupported.length === 0
          ? `All ${claims.length} specific ${claims.length === 1 ? 'claim appears' : 'claims appear'} in the context.`
          : `Not found in the context: ${unsupported
              .slice(0, 5)
              .map((c) => `"${c.text}"`)
              .join(', ')}${unsupported.length > 5 ? ', …' : ''}.`,
      metadata: {
        claims: claims.length,
        unsupported: unsupported.map((c) => ({ kind: c.kind, text: c.text })),
      },
    };
  },
});

// ─── relevance ───────────────────────────────────────────────────────────────────────────────

function questionText(input: JsonValue, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  if (typeof input === 'string') return input;
  if (isJsonObject(input)) {
    const strings = Object.values(input).filter((v): v is string => typeof v === 'string');
    if (strings.length === 1) return strings[0] as string;
    if (typeof input.question === 'string') return input.question;
    if (typeof input.query === 'string') return input.query;
  }
  return asText(input);
}

export const relevance = defineEvaluator({
  type: 'relevance',
  kind: 'heuristic',
  description:
    "Share of the question's key terms that the answer addresses. A coarse signal: an answer can repeat the question's words without answering it.",
  defaultThreshold: 0.5,
  argsSchema: z.strictObject({ question: z.string().optional() }),
  evaluate({ input, output, args }): EvaluatorOutcome {
    const question = questionText(input, args.question);
    const questionTerms = [...new Set(terms(question))];
    if (questionTerms.length === 0)
      return { score: null, skipped: true, reason: 'The question has no key terms to look for.' };
    const answerText = asText(output);
    const answerTerms = new Set(terms(answerText));
    const covered = questionTerms.filter((t) => answerTerms.has(t));
    const missing = questionTerms.filter((t) => !answerTerms.has(t));
    const score = covered.length / questionTerms.length;
    const abstains = ABSTENTION.test(answerText);
    return {
      score,
      reason: abstains
        ? 'The answer declines to answer the question.'
        : `The answer addresses ${covered.length} of ${questionTerms.length} key terms${missing.length ? ` (missing: ${missing.slice(0, 5).join(', ')})` : ''}.`,
      metadata: { covered, missing, abstains },
    };
  },
});
