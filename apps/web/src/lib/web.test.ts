import type { Span } from '@scope-ai/protocol';
import { describe, expect, it } from 'vitest';
import { axisLabels, columnPath, nearestIndex, niceTicks } from '../charts/scale.ts';
import { formatCost, formatPrice } from './format.ts';
import {
  chatMessages,
  readablePreview,
  redactionCount,
  requestParams,
  responseText,
  retrievedDocuments,
  truncation,
} from './payload.ts';
import { ancestors, layoutWaterfall, parentIds, timeTicks } from './spans.ts';

function span(
  id: string,
  parentId: string | null,
  offsetMs: number,
  durationMs: number,
  extra: Partial<Span> = {},
): Span {
  return {
    id,
    parentId,
    name: id,
    kind: 'step',
    status: 'ok',
    statusMessage: null,
    startTime: new Date(1000 + offsetMs).toISOString(),
    offsetMs,
    durationMs,
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

describe('waterfall layout', () => {
  const spans = [
    span('eval', null, 100, 20, { kind: 'evaluation' }),
    span('judge', 'eval', 105, 10, { kind: 'llm' }),
    span('root', null, 0, 100, { kind: 'workflow' }),
    span('b', 'root', 40, 60),
    span('a', 'root', 0, 40),
    span('orphan', 'missing', 50, 5),
  ];

  it('orders depth-first by start time and scales bars to the total extent', () => {
    const { rows, totalMs } = layoutWaterfall(spans);
    expect(totalMs).toBe(120);
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.span.id}`)).toEqual([
      'root',
      '  a',
      '  b',
      'orphan',
      'eval',
      '  judge',
    ]);
    const b = rows.find((r) => r.span.id === 'b');
    expect(b?.left).toBeCloseTo(40 / 120);
    expect(b?.width).toBeCloseTo(60 / 120);
  });

  it('marks everything under an evaluation span', () => {
    const { rows } = layoutWaterfall(spans);
    const inEval = rows.filter((r) => r.inEvaluation).map((r) => r.span.id);
    expect(inEval).toEqual(['eval', 'judge']);
  });

  it('hides descendants of collapsed spans', () => {
    const { rows } = layoutWaterfall(spans, new Set(['root']));
    expect(rows.map((r) => r.span.id)).toEqual(['root', 'orphan', 'eval', 'judge']);
    expect(rows[0]?.childCount).toBe(2);
  });

  it('finds parents and ancestors', () => {
    expect([...parentIds(spans)].sort()).toEqual(['eval', 'missing', 'root']);
    expect(ancestors(spans, 'judge').map((s) => s.id)).toEqual(['eval']);
    expect(ancestors(spans, 'orphan')).toEqual([]);
  });

  it('picks round time ticks', () => {
    expect(timeTicks(0.61, 3)).toEqual([0, 0.25, 0.5]);
    expect(timeTicks(1234, 4)).toEqual([0, 500, 1000]);
    expect(timeTicks(0)).toEqual([0]);
  });
});

describe('chart scales', () => {
  it('rounds axis ticks up to cover the maximum', () => {
    expect(niceTicks(1, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceTicks(72, 4)).toEqual([0, 20, 40, 60, 80]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it('spaces labels by their width and never repeats one', () => {
    const days = ['Sep 21', 'Sep 21', 'Sep 21', 'Sep 22', 'Sep 22', 'Sep 23'];
    expect(axisLabels(days, 100)).toEqual(['Sep 21', null, null, 'Sep 22', null, 'Sep 23']);
    // Narrow bands: every third label at most.
    expect(axisLabels(['a1', 'a2', 'a3', 'a4', 'a5'], 8)).toEqual(['a1', null, null, 'a4', null]);
  });

  it('draws rounded data-ends and square bases', () => {
    const d = columnPath(10, 20, 24, 50, 4);
    expect(d.startsWith('M10,70')).toBe(true);
    expect(d).toContain('Q10,20 14,20');
    expect(columnPath(0, 0, 10, 0)).toBe('');
  });

  it('snaps to the nearest position', () => {
    expect(nearestIndex([0, 10, 20], 14)).toBe(1);
    expect(nearestIndex([0, 10, 20], 16)).toBe(2);
  });
});

describe('payloads', () => {
  const input = {
    model: 'openai:gpt-5',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    temperature: 0,
  };

  it('reads model calls as conversations', () => {
    expect(chatMessages(input)).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: JSON.stringify([{ type: 'text', text: 'hi' }], null, 2) },
    ]);
    expect(requestParams(input)).toEqual({ model: 'openai:gpt-5', temperature: 0 });
    expect(chatMessages({ prompt: 'x' })).toBeNull();
    expect(responseText({ text: 'hello' })).toBe('hello');
    expect(responseText({ choices: [] })).toBeNull();
  });

  it('reads retrievals as ranked documents', () => {
    expect(
      retrievedDocuments({ documents: [{ id: 'd1', source: 'a.md', text: 'x', score: 1.5 }] }),
    ).toEqual([{ id: 'd1', source: 'a.md', title: null, text: 'x', score: 1.5 }]);
    expect(retrievedDocuments('text')).toBeNull();
  });

  it('recognizes privacy markers', () => {
    expect(truncation({ $truncated: true, originalBytes: 100_000, preview: '{"a' })).toEqual({
      originalBytes: 100_000,
      preview: '{"a',
    });
    expect(truncation({ a: 1 })).toBeNull();
    expect(redactionCount({ key: 'sk [redacted:openai_key] and [redacted:jwt]' })).toBe(2);
  });

  it('makes single-field output previews readable', () => {
    expect(readablePreview('{ "answer": "Refunds take 5 days." }')).toBe(
      'answer: Refunds take 5 days.',
    );
    expect(readablePreview('{ "answer": "a \\"quoted\\" word" }')).toBe('answer: a "quoted" word');
    expect(readablePreview('{ "answer": "cut off…')).toBe('answer: cut off…');
    expect(readablePreview('{ "a": 1, "b": 2 }')).toBe('{ "a": 1, "b": 2 }');
    expect(readablePreview('plain text')).toBe('plain text');
  });
});

describe('formatting', () => {
  it('never shows an unknown cost as $0', () => {
    expect(formatCost(null)).toBe('unknown');
    expect(formatCost(0)).toBe('$0.00');
  });

  it('shows prices without float noise', () => {
    expect(formatPrice(0.30000000000000004)).toBe('$0.3');
    expect(formatPrice(12.5)).toBe('$12.5');
    expect(formatPrice(null)).toBe('—');
  });
});
