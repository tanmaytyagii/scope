import { describe, expect, it } from 'vitest';
import { isSpanId, isTraceId, newSpanId, newTraceId, shortId, ulid } from './ids.ts';
import { toJsonValue } from './json.ts';
import { createLogger } from './logger.ts';
import type { SpanRecord } from './model.ts';
import { sentences, stem, suggest, terms, words } from './text.ts';
import { buildSpanTree, flattenSpanTree, rollupSpans } from './trace.ts';

describe('text', () => {
  it('splits sentences around decimals, abbreviations and list markers', () => {
    const text = [
      '# Refund policy',
      'Refunds take 5.5 days, e.g. for cards. Store credit is instant!',
      '- Items must be unused.',
      '1. Keep the receipt',
    ].join('\n');
    expect(sentences(text)).toEqual([
      'Refund policy',
      'Refunds take 5.5 days, e.g. for cards.',
      'Store credit is instant!',
      'Items must be unused.',
      'Keep the receipt',
    ]);
  });

  it('tokenizes and stems conservatively', () => {
    expect(words("We've shipped 1,200 items at 3.5%")).toEqual([
      "we've",
      'shipped',
      '1,200',
      'items',
      'at',
      '3.5%',
    ]);
    expect(terms('The refunds were processed quickly')).toEqual(['refund', 'process', 'quickly']);
    expect(stem('shipping')).toBe('ship');
    expect(stem('policies')).toBe('policy');
    expect(stem('status')).toBe('status');
  });

  it('suggests close matches only', () => {
    expect(suggest('temprature', ['temperature', 'max_tokens'])).toBe('temperature');
    expect(suggest('xyz', ['temperature', 'max_tokens'])).toBeUndefined();
  });
});

describe('ids', () => {
  it('generates OpenTelemetry-compatible trace and span ids', () => {
    expect(isTraceId(newTraceId())).toBe(true);
    expect(isSpanId(newSpanId())).toBe(true);
    expect(isTraceId('0'.repeat(32))).toBe(false);
  });

  it('generates time-sortable ULIDs', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it('shortens ids for display', () => {
    expect(shortId('8f31c0aa11223344556677889900aabb')).toBe('8f31c0a');
    expect(shortId('run_01J9ZX4Q8Y')).toBe('01j9zx4');
  });
});

function span(
  id: string,
  parentId: string | null,
  kind: SpanRecord['kind'],
  extra: Partial<SpanRecord> = {},
): SpanRecord {
  return {
    traceId: 't',
    id,
    parentId,
    name: id,
    kind,
    status: 'ok',
    statusMessage: null,
    startTime: 0,
    endTime: 1,
    durationMs: 1,
    input: null,
    output: null,
    attributes: {},
    events: [],
    error: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    ...extra,
  };
}

describe('trace rollups', () => {
  const spans = [
    span('root', null, 'workflow'),
    span('llm1', 'root', 'llm', {
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
      startTime: 5,
    }),
    span('llm2', 'root', 'llm', {
      provider: 'acme',
      model: 'x',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: null,
      startTime: 2,
    }),
    span('eval', 'root', 'evaluation', { startTime: 9 }),
    span('judge', 'eval', 'llm', {
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 500,
      outputTokens: 50,
      costUsd: 0.01,
    }),
  ];

  it('excludes evaluation spans from usage and cost', () => {
    const rollup = rollupSpans(spans);
    expect(rollup.usage).toMatchObject({ inputTokens: 110, outputTokens: 25, totalTokens: 135 });
    expect(rollup.llmCallCount).toBe(2);
    expect(rollup.spanCount).toBe(5);
    expect(rollup.costUsd).toBeNull();
    expect(rollup.unpricedModels).toEqual(['acme:x']);
  });

  it('counts cache tokens only from whole, non-negative attribute values', () => {
    const cached = (value: unknown) =>
      span('llm', null, 'llm', {
        inputTokens: 10,
        outputTokens: 1,
        attributes: { 'gen_ai.usage.cache_read_input_tokens': value as number },
      });
    const rollup = rollupSpans([cached(-1e12), cached(2.5), cached(Number.NaN), cached(40)]);
    expect(rollup.usage).toMatchObject({ cacheReadTokens: 40, totalTokens: 84 });
  });

  it('builds an ordered tree', () => {
    const flat = flattenSpanTree(buildSpanTree(spans));
    expect(flat.map((n) => [n.span.id, n.depth])).toEqual([
      ['root', 0],
      ['llm2', 1],
      ['llm1', 1],
      ['eval', 1],
      ['judge', 2],
    ]);
  });
});

describe('logger', () => {
  it('writes JSON records, redacts secrets and omits content fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l) => lines.push(l), now: () => 0 });
    logger.info('called provider with sk-proj-abcdefghijklmnopqrstuvwxyz', {
      prompt: 'private words',
      traceId: 'abc',
    });
    logger.debug('hidden');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string);
    expect(record).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'called provider with [redacted:openai_key]',
      prompt: '[omitted 13 bytes]',
      traceId: 'abc',
    });
  });
});

describe('toJsonValue', () => {
  it('converts maps, sets and binary data', () => {
    expect(
      toJsonValue({
        m: new Map([['a', 1]]),
        s: new Set([1, 2]),
        b: new Uint8Array(3),
        n: Number.NaN,
      }),
    ).toEqual({
      m: { a: 1 },
      s: [1, 2],
      b: '[binary 3 bytes]',
      n: 'NaN',
    });
  });
});

describe('bm25', () => {
  it('ranks documents by relevance with deterministic ties', async () => {
    const { createBm25Index } = await import('./bm25.ts');
    const index = createBm25Index([
      'Shipping to Canada takes 7 days.',
      'Refunds are processed in 5 business days.',
      'Our office is closed on public holidays.',
      'Refunds for gift cards are not available.',
    ]);
    const hits = index.search('how long do refunds take', 3);
    // "take" occurs in one document (high IDF); among the two "refund" documents the shorter wins.
    expect(hits.map((h) => h.index)).toEqual([0, 3, 1]);
    expect(hits[0]?.matched).toEqual(['take']);
    expect(index.search('refund processing', 1).map((h) => h.index)).toEqual([1]);
    expect(index.search('the and of')).toEqual([]);
  });
});
