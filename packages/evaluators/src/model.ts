/**
 * Model-based evaluators. Their scores are a model's opinion, recorded with the judge model,
 * the prompt version and the raw response so they can be audited.
 */
import { asText, type JsonValue } from '@scope-ai/core';
import { z } from 'zod';
import { defineEvaluator, type EvaluatorOutcome } from './types.ts';

export const JUDGE_PROMPT_VERSION = 'scope.llm_judge/v1';

const JUDGE_SYSTEM = [
  'You are an impartial evaluator of AI system outputs.',
  'Grade the RESPONSE strictly against the RUBRIC. Use the INPUT, and the REFERENCE and CONTEXT when provided.',
  'Do not reward length or style unless the rubric asks for it. If the response is empty or off-topic, give the lowest score.',
  'Reply with only a JSON object: {"score": <integer 1-5>, "reason": "<one or two sentences>"}.',
  'Scale: 1 = fails the rubric, 2 = mostly fails, 3 = partially meets, 4 = mostly meets, 5 = fully meets.',
].join('\n');

function section(title: string, body: string): string {
  return `<${title}>\n${body}\n</${title}>`;
}

export function buildJudgePrompt(opts: {
  rubric: string;
  input: JsonValue;
  output: JsonValue;
  expected: JsonValue | null;
  context: string | null;
  includeContext: boolean;
}): string {
  const parts = [section('RUBRIC', opts.rubric), section('INPUT', asText(opts.input))];
  if (opts.expected !== null) parts.push(section('REFERENCE', asText(opts.expected)));
  if (opts.includeContext && opts.context) parts.push(section('CONTEXT', opts.context));
  parts.push(section('RESPONSE', asText(opts.output)));
  parts.push('Grade the RESPONSE now. Reply with the JSON object only.');
  return parts.join('\n\n');
}

/** Extracts `{ score, reason }` from a judge reply, tolerating code fences and surrounding text. */
export function parseJudgeReply(text: string): { score: number; reason: string } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
    const score = typeof parsed.score === 'number' ? parsed.score : Number(parsed.score);
    if (!Number.isFinite(score) || score < 1 || score > 5) return null;
    return { score, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return null;
  }
}

export const llmJudge = defineEvaluator({
  type: 'llm_judge',
  kind: 'model',
  description:
    'A judge model grades the output against a rubric on a 1–5 scale (normalized to 0–1).',
  requires: ['model'],
  defaultThreshold: 0.75,
  argsSchema: z.strictObject({
    model: z.string().regex(/^[^:\s]+:\S+$/, 'use provider:model, e.g. anthropic:claude-opus-5'),
    rubric: z.string().min(10, 'describe what a good response looks like (at least a sentence)'),
    include_context: z.boolean().default(true),
    max_tokens: z.number().int().positive().default(1024),
  }),
  async evaluate({ input, output, expected, context, args }, ctx): Promise<EvaluatorOutcome> {
    const prompt = buildJudgePrompt({
      rubric: args.rubric,
      input,
      output,
      expected,
      context,
      includeContext: args.include_context,
    });
    const response = await ctx.models.complete(args.model, {
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      maxTokens: args.max_tokens,
    });
    const verdict = parseJudgeReply(response.text);
    const metadata = {
      judge_model: response.model,
      prompt_version: JUDGE_PROMPT_VERSION,
      raw_response: response.text.slice(0, 2000),
    };
    if (!verdict) {
      throw Object.assign(
        new Error(`The judge reply was not a valid {"score": 1-5, "reason": …} object.`),
        { metadata },
      );
    }
    return {
      score: (verdict.score - 1) / 4,
      reason: `Judge (${response.model}) scored ${verdict.score}/5: ${verdict.reason || 'no reason given'}`,
      metadata: { ...metadata, raw_score: verdict.score },
    };
  },
});

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0)
    throw new Error('Embedding vectors must be non-empty and the same length.');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const embeddingSimilarity = defineEvaluator({
  type: 'embedding_similarity',
  kind: 'model',
  description: 'Cosine similarity between embeddings of the output and the expected answer.',
  requires: ['expected', 'model'],
  defaultThreshold: 0.8,
  argsSchema: z.strictObject({
    model: z
      .string()
      .regex(/^[^:\s]+:\S+$/, 'use provider:model, e.g. openai:text-embedding-3-small'),
  }),
  async evaluate({ output, expected, args }, ctx): Promise<EvaluatorOutcome> {
    if (expected === null)
      return {
        score: null,
        skipped: true,
        reason: 'The case has no expected value to compare against.',
      };
    const response = await ctx.models.embed(args.model, [asText(output), asText(expected)]);
    const [a, b] = response.vectors;
    if (!a || !b) throw new Error('The embedding model returned fewer vectors than requested.');
    const score = Math.max(0, cosineSimilarity(a, b));
    return {
      score,
      reason: `Cosine similarity ${score.toFixed(3)} (${response.model}).`,
      metadata: { embedding_model: response.model },
    };
  },
});
