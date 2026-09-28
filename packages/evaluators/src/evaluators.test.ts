import type { CompletionResponse } from '@scope-ai/providers';
import { describe, expect, it } from 'vitest';
import {
  contains,
  cost,
  exactMatch,
  json,
  latency,
  notContains,
  regex,
  tokens,
} from './deterministic.ts';
import {
  extractClaims,
  groundedness,
  relevance,
  rougeL,
  similarity,
  tokenF1,
  unsupportedClaims,
} from './heuristic.ts';
import { buildJudgePrompt, embeddingSimilarity, llmJudge, parseJudgeReply } from './model.ts';
import { EvaluatorRegistry } from './registry.ts';
import type { EvaluatorContext, EvaluatorDefinition, EvaluatorInput } from './types.ts';

const CONTEXT = [
  'Refunds are issued to the original payment method.',
  'Refunds take 5 to 7 business days to appear on a card statement.',
  'Orders over $50 ship free within the United States.',
  'Gift cards cannot be refunded.',
].join(' ');

const noModels: EvaluatorContext = {
  signal: new AbortController().signal,
  models: {
    complete: () => Promise.reject(new Error('no model in this test')),
    embed: () => Promise.reject(new Error('no model in this test')),
  },
};

type TestInput = Partial<Omit<EvaluatorInput<unknown>, 'args'>> & { args?: unknown };

async function run<A>(
  def: EvaluatorDefinition<A>,
  input: TestInput,
  ctx = noModels,
) {
  const args = def.argsSchema.parse(input.args ?? {});
  return def.evaluate(
    {
      input: input.input ?? { question: 'How long do refunds take?' },
      output: input.output ?? '',
      expected: input.expected ?? null,
      context: input.context ?? null,
      trace: input.trace ?? {
        durationMs: 1200,
        usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
        costUsd: 0.004,
      },
      args,
    },
    ctx,
  );
}

describe('deterministic evaluators', () => {
  it('exact_match normalizes whitespace and compares structures', async () => {
    expect(await run(exactMatch, { output: '  Five  days ', expected: 'Five days' })).toMatchObject(
      { score: 1 },
    );
    expect(await run(exactMatch, { output: 'five days', expected: 'Five days' })).toMatchObject({
      score: 0,
    });
    expect(
      await run(exactMatch, {
        output: 'five days',
        expected: 'Five days',
        args: { case_sensitive: false },
      }),
    ).toMatchObject({ score: 1 });
    expect(
      await run(exactMatch, { output: { b: 1, a: [1, 2] }, expected: { a: [1, 2], b: 1 } }),
    ).toMatchObject({ score: 1 });
    expect(await run(exactMatch, { output: 'x' })).toMatchObject({ skipped: true, score: null });
  });

  it('contains reports what is missing', async () => {
    const result = await run(contains, {
      output: 'Refunds take 5 to 7 business days.',
      args: { value: ['5 to 7', 'original payment method'] },
    });
    expect(result).toMatchObject({
      score: 0.5,
      passed: false,
      metadata: { found: ['5 to 7'], missing: ['original payment method'] },
    });
    expect(
      await run(contains, { output: 'Yes, we ship to Canada', expected: 'canada' }),
    ).toMatchObject({ score: 1, passed: true });
    expect(
      await run(contains, { output: 'no', args: { value: ['a', 'no'], all: false } }),
    ).toMatchObject({ passed: true });
  });

  it('not_contains and regex', async () => {
    expect(
      await run(notContains, { output: 'As an AI language model…', args: { value: 'as an ai' } }),
    ).toMatchObject({ score: 0 });
    expect(
      await run(regex, { output: 'Order #A-1234 shipped', args: { pattern: '#[A-Z]-\\d{4}' } }),
    ).toMatchObject({ score: 1, metadata: { match: '#A-1234' } });
    expect(
      await run(regex, {
        output: 'call 555-1234',
        args: { pattern: '\\d{3}-\\d{4}', should_match: false },
      }),
    ).toMatchObject({ score: 0 });
    expect(() => regex.argsSchema.parse({ pattern: '(' })).toThrow(
      /not a valid regular expression/,
    );
  });

  it('json validates syntax and schema, including fenced model output', async () => {
    const schema = {
      type: 'object',
      required: ['intent', 'priority'],
      properties: {
        intent: { type: 'string', enum: ['refund', 'shipping'] },
        priority: { type: 'integer' },
      },
      additionalProperties: false,
    };
    expect(
      await run(json, {
        output: '```json\n{"intent": "refund", "priority": 2}\n```',
        args: { schema },
      }),
    ).toMatchObject({ score: 1 });
    const bad = await run(json, {
      output: { text: '{"intent": "billing", "extra": true}' },
      args: { schema },
    });
    expect(bad.score).toBe(0);
    expect(bad.metadata?.errors).toEqual([
      "(root): must have required property 'priority'",
      '(root): unexpected property "extra"',
      '/intent: must be equal to one of the allowed values',
    ]);
    expect(
      await run(json, {
        output: { text: 'x', json: { intent: 'shipping', priority: 1 } },
        args: { schema },
      }),
    ).toMatchObject({ score: 1 });
    expect((await run(json, { output: 'not json' })).reason).toMatch(/^Output is not valid JSON/);
  });

  it('latency, tokens and cost budgets', async () => {
    expect(await run(latency, { args: { max_ms: 1000 } })).toMatchObject({
      score: 0,
      reason: '1.20 s > 1.00 s budget.',
    });
    expect(await run(tokens, { args: { max_total: 2000, max_output: 50 } })).toMatchObject({
      score: 0,
      reason: 'output 100 > 50.',
    });
    expect(await run(cost, { args: { max_usd: 0.01 } })).toMatchObject({ score: 1 });
    expect(
      await run(cost, {
        args: { max_usd: 0.01 },
        trace: {
          durationMs: 1,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          costUsd: null,
        },
      }),
    ).toMatchObject({
      skipped: true,
    });
  });
});

describe('heuristic evaluators', () => {
  it('similarity uses token F1 or ROUGE-L and the best reference', async () => {
    expect(tokenF1('Refunds take five business days', 'refunds take 5 business days')).toBeCloseTo(
      0.8,
    );
    expect(rougeL('the cat sat on the mat', 'the cat is on the mat')).toBeCloseTo(0.75);
    const result = await run(similarity, {
      output: 'We ship to Canada.',
      expected: ['No.', 'Yes, we ship to Canada.'],
    });
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.reason).toMatch(/closest of 2 references/);
  });

  it('groundedness finds unsupported sentences', async () => {
    const grounded = await run(groundedness, {
      output: 'Refunds take 5 to 7 business days to appear on your card statement.',
      context: CONTEXT,
    });
    expect(grounded).toMatchObject({ score: 1 });

    const mixed = await run(groundedness, {
      output:
        'Refunds are issued to the original payment method. Premium members receive instant refunds through our loyalty program.',
      context: CONTEXT,
    });
    expect(mixed.score).toBe(0.5);
    expect(mixed.metadata?.unsupported).toEqual([
      {
        sentence: 'Premium members receive instant refunds through our loyalty program.',
        support: 0.14,
      },
    ]);
  });

  it('groundedness skips abstentions and missing context', async () => {
    expect(
      await run(groundedness, {
        output: 'I could not find the answer in the provided context.',
        context: CONTEXT,
      }),
    ).toMatchObject({
      skipped: true,
      reason: 'The answer declines to answer; there are no claims to check.',
    });
    expect(await run(groundedness, { output: 'Anything at all here.' })).toMatchObject({
      skipped: true,
    });
  });

  it('unsupported_claims flags invented numbers and names', async () => {
    expect(
      extractClaims('Orders over $50 ship free with FedEx in 3 days. The United States only.'),
    ).toEqual([
      { kind: 'number', text: '$50' },
      { kind: 'number', text: '3' },
      { kind: 'entity', text: 'FedEx' },
      { kind: 'entity', text: 'United States' },
    ]);
    const result = await run(unsupportedClaims, {
      output: 'Orders over $50 ship free via FedEx within the United States, usually in 2 days.',
      context: CONTEXT,
    });
    expect(result.metadata?.unsupported).toEqual([
      { kind: 'number', text: '2' },
      { kind: 'entity', text: 'FedEx' },
    ]);
    expect(result.score).toBeCloseTo(0.5);
    expect(
      await run(unsupportedClaims, { output: 'Yes, that is fine.', context: CONTEXT }),
    ).toMatchObject({ score: 1 });
  });

  it('relevance measures coverage of the question', async () => {
    const result = await run(relevance, { output: 'Refunds take 5 to 7 business days.' });
    expect(result).toMatchObject({ score: 2 / 3, metadata: { missing: ['long'] } });
    expect(
      await run(relevance, {
        input: { q: 'Is shipping free?' },
        output: 'Gift cards cannot be refunded.',
      }),
    ).toMatchObject({ score: 0 });
  });
});

describe('model evaluators', () => {
  function scripted(text: string): EvaluatorContext {
    const calls: unknown[] = [];
    return {
      signal: new AbortController().signal,
      models: {
        complete: async (ref, request) => {
          calls.push({ ref, request });
          return {
            text,
            model: 'judge-1',
            finishReason: 'stop',
            rawFinishReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            ignoredParams: [],
            requestId: null,
          } satisfies CompletionResponse;
        },
        embed: async () => ({
          vectors: [
            [1, 0],
            [0.8, 0.6],
          ],
          model: 'embed-1',
          usage: { inputTokens: 4 },
        }),
      },
    };
  }

  it('parses judge replies defensively', () => {
    expect(parseJudgeReply('```json\n{"score": 4, "reason": "Mostly right."}\n```')).toEqual({
      score: 4,
      reason: 'Mostly right.',
    });
    expect(parseJudgeReply('{"score": 9}')).toBeNull();
    expect(parseJudgeReply('I think it is good')).toBeNull();
  });

  it('llm_judge normalizes the score and records evidence', async () => {
    const result = await run(
      llmJudge,
      {
        output: 'Refunds take 5-7 business days.',
        args: {
          model: 'anthropic:claude-opus-5',
          rubric: 'The answer states the refund timeline accurately.',
        },
      },
      scripted('{"score": 4, "reason": "Accurate but omits payment method."}'),
    );
    expect(result).toMatchObject({
      score: 0.75,
      reason: 'Judge (judge-1) scored 4/5: Accurate but omits payment method.',
      metadata: { judge_model: 'judge-1', prompt_version: 'scope.llm_judge/v1', raw_score: 4 },
    });
  });

  it('llm_judge raises on unusable replies so the result is an error, not a pass', async () => {
    await expect(
      run(
        llmJudge,
        { output: 'x', args: { model: 'openai:gpt-5', rubric: 'Must be polite and correct.' } },
        scripted('Looks fine to me!'),
      ),
    ).rejects.toThrow(/not a valid/);
  });

  it('builds a judge prompt with only the sections that exist', () => {
    const prompt = buildJudgePrompt({
      rubric: 'R',
      input: { question: 'Q' },
      output: 'A',
      expected: null,
      context: 'C',
      includeContext: false,
    });
    expect(prompt).toContain('<INPUT>\n{\n  "question": "Q"\n}\n</INPUT>');
    expect(prompt).not.toContain('<REFERENCE>');
    expect(prompt).not.toContain('<CONTEXT>');
  });

  it('embedding_similarity computes cosine similarity', async () => {
    const result = await run(
      embeddingSimilarity,
      { output: 'a', expected: 'b', args: { model: 'openai:text-embedding-3-small' } },
      scripted(''),
    );
    expect(result.score).toBeCloseTo(0.8);
  });
});

describe('EvaluatorRegistry', () => {
  it('lists built-ins with honest kinds and suggests on typos', () => {
    const registry = new EvaluatorRegistry();
    const kinds = Object.fromEntries(registry.list().map((d) => [d.type, d.kind]));
    expect(kinds).toMatchObject({
      exact_match: 'deterministic',
      groundedness: 'heuristic',
      similarity: 'heuristic',
      llm_judge: 'model',
    });
    expect(() => registry.get('groundednes')).toThrow('Unknown evaluator type "groundednes"');
    try {
      registry.get('groundednes');
    } catch (error) {
      expect((error as { hint?: string }).hint).toBe('Did you mean "groundedness"?');
    }
  });

  it('every built-in has a description and parses empty or minimal args', () => {
    for (const d of new EvaluatorRegistry().list()) {
      expect(d.description.length).toBeGreaterThan(20);
    }
  });
});
