/**
 * Mapping of the attribute conventions that the end-to-end tests (OpenTelemetry JS exporters,
 * AI SDK) do not produce: OpenInference, OpenLLMetry and the older GenAI content events. The
 * attribute sets follow each project's documented conventions.
 */
import { describe, expect, it } from 'vitest';
import { decodeJson, decodeProtobuf, OtlpDecodeError, type OtlpSpan } from './decode.ts';
import { mapResourceSpans, mapSpan } from './map.ts';

function span(attributes: OtlpSpan['attributes'], extra: Partial<OtlpSpan> = {}): OtlpSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: 'c'.repeat(16),
    name: 'span',
    kind: 1,
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_000_500_000_000n,
    attributes,
    events: [],
    status: { code: 0, message: '' },
    ...extra,
  };
}

describe('OpenInference', () => {
  it('maps an LLM span with indexed messages and token counts', () => {
    const s = mapSpan(
      span({
        'openinference.span.kind': 'LLM',
        'llm.provider': 'anthropic',
        'llm.model_name': 'claude-sonnet-5',
        'llm.token_count.prompt': 300,
        'llm.token_count.completion': 40,
        'llm.input_messages.0.message.role': 'system',
        'llm.input_messages.0.message.content': 'Be brief.',
        'llm.input_messages.1.message.role': 'user',
        'llm.input_messages.1.message.content': 'Hi',
        'llm.output_messages.0.message.role': 'assistant',
        'llm.output_messages.0.message.content': 'Hello.',
        'llm.invocation_parameters': '{"temperature":0}',
      }),
      'openinference.instrumentation.anthropic',
      {},
    );
    expect(s).toMatchObject({
      kind: 'llm',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 300,
      outputTokens: 40,
      input: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hi' },
        ],
      },
      output: { text: 'Hello.' },
      durationMs: 500,
    });
    expect(s.costUsd).toBeGreaterThan(0);
    expect(Object.keys(s.attributes).some((k) => k.startsWith('llm.input_messages'))).toBe(false);
    expect(s.attributes['llm.invocation_parameters']).toBe('{"temperature":0}');
  });

  it('maps a retriever span to ranked documents', () => {
    const s = mapSpan(
      span({
        'openinference.span.kind': 'RETRIEVER',
        'input.value': 'refund window',
        'retrieval.documents.0.document.id': 'refunds.md#2',
        'retrieval.documents.0.document.content': 'Returns are accepted within 30 days.',
        'retrieval.documents.0.document.score': 0.82,
        'retrieval.documents.1.document.content': 'Gift cards are final sale.',
      }),
      '',
      {},
    );
    expect(s).toMatchObject({
      kind: 'retrieval',
      input: 'refund window',
      output: {
        documents: [
          { id: 'refunds.md#2', text: 'Returns are accepted within 30 days.', score: 0.82 },
          { id: '1', text: 'Gift cards are final sale.', score: null },
        ],
      },
    });
  });

  it('parses JSON values and maps chains and tools', () => {
    expect(
      mapSpan(span({ 'openinference.span.kind': 'CHAIN', 'input.value': '{"q":"x"}' }), '', {}),
    ).toMatchObject({ kind: 'step', input: { q: 'x' } });
    expect(mapSpan(span({ 'openinference.span.kind': 'TOOL' }), '', {}).kind).toBe('tool');
  });
});

describe('OpenLLMetry (Traceloop)', () => {
  it('maps indexed prompts and completions and the older token names', () => {
    const s = mapSpan(
      span({
        'llm.request.type': 'chat',
        'gen_ai.system': 'OpenAI',
        'gen_ai.request.model': 'gpt-5',
        'gen_ai.usage.prompt_tokens': 12,
        'gen_ai.usage.completion_tokens': 3,
        'gen_ai.prompt.0.role': 'user',
        'gen_ai.prompt.0.content': 'Hi',
        'gen_ai.completion.0.role': 'assistant',
        'gen_ai.completion.0.content': 'Hello.',
        'gen_ai.completion.0.finish_reason': 'stop',
      }),
      'opentelemetry.instrumentation.openai',
      {},
    );
    expect(s).toMatchObject({
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 12,
      outputTokens: 3,
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      output: { text: 'Hello.' },
    });
  });

  it('maps workflow and task spans', () => {
    expect(mapSpan(span({ 'traceloop.span.kind': 'workflow' }), '', {}).kind).toBe('workflow');
    expect(mapSpan(span({ 'traceloop.span.kind': 'task' }), '', {}).kind).toBe('step');
  });
});

describe('GenAI conventions', () => {
  it('reads content from the older span events and drops those events', () => {
    const s = mapSpan(
      span(
        { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'openai', 'gen_ai.request.model': 'x' },
        {
          events: [
            {
              name: 'gen_ai.content.prompt',
              timeUnixNano: 1n,
              attributes: { 'gen_ai.prompt': '[{"role":"user","content":"Hi"}]' },
            },
            {
              name: 'gen_ai.content.completion',
              timeUnixNano: 2n,
              attributes: { 'gen_ai.completion': 'Hello.' },
            },
          ],
        },
      ),
      '',
      {},
    );
    expect(s.input).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(s.output).toEqual({ text: 'Hello.' });
    expect(s.events).toEqual([]);
  });

  it('leaves the cost unknown for models without a price', () => {
    const s = mapSpan(
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'acme',
        'gen_ai.request.model': 'm1',
        'gen_ai.usage.input_tokens': 10,
      }),
      '',
      {},
    );
    expect(s).toMatchObject({ kind: 'llm', provider: 'acme', costUsd: null, inputTokens: 10 });
  });

  it('ignores token counts that are not whole, non-negative numbers', () => {
    const s = mapSpan(
      span({
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': 'gpt-5',
        'gen_ai.usage.input_tokens': -500,
        'gen_ai.usage.output_tokens': 2.5,
        'gen_ai.usage.cache_read.input_tokens': -100,
      }),
      '',
      {},
    );
    expect(s).toMatchObject({ kind: 'llm', inputTokens: null, outputTokens: null, costUsd: null });
    expect(s.attributes['gen_ai.usage.cache_read_input_tokens']).toBeUndefined();
  });

  it('bounds names, messages and model fields as the SDK ingestion schema does', () => {
    const long = 'x'.repeat(100_000);
    const s = mapSpan(
      span(
        {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': long,
          'gen_ai.request.model': long,
        },
        {
          name: long,
          status: { code: 2, message: long },
          events: [
            {
              name: 'exception',
              timeUnixNano: 1_700_000_000_100_000_000n,
              attributes: {
                'exception.type': long,
                'exception.message': long,
                'exception.stacktrace': long,
              },
            },
          ],
        },
      ),
      '',
      {},
    );
    expect(s.name).toHaveLength(256);
    expect(s.provider).toHaveLength(128);
    expect(s.model).toHaveLength(256);
    expect(s.statusMessage).toHaveLength(16_384);
    expect(s.error?.type).toHaveLength(256);
    expect(s.error?.message).toHaveLength(16_384);
    expect(s.error?.stack).toHaveLength(32_768);
  });

  it('records exceptions as the span error', () => {
    const s = mapSpan(
      span(
        {},
        {
          status: { code: 2, message: 'boom' },
          events: [
            {
              name: 'exception',
              timeUnixNano: 1n,
              attributes: {
                'exception.type': 'TimeoutError',
                'exception.message': 'took too long',
              },
            },
          ],
        },
      ),
      '',
      {},
    );
    expect(s).toMatchObject({
      status: 'error',
      error: { type: 'TimeoutError', message: 'took too long' },
    });
  });

  it('flattens nested and mixed attribute values', () => {
    const s = mapSpan(
      span({ nested: { a: 1 }, mixed: [1, 'x'], list: ['a', 'b'], none: null }),
      '',
      {},
    );
    expect(s.attributes).toMatchObject({ nested: '{"a":1}', mixed: '[1,"x"]', list: ['a', 'b'] });
    expect(s.attributes.none).toBeUndefined();
  });
});

describe('decoding', () => {
  it('accepts JSON with base64 ids, string enums and 64-bit integers as strings', () => {
    const [rs] = decodeJson({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'app' } }] },
          scope_spans: [
            {
              spans: [
                {
                  traceId: Buffer.alloc(16, 1).toString('base64'),
                  spanId: Buffer.alloc(8, 2).toString('base64'),
                  name: 'x',
                  kind: 'SPAN_KIND_CLIENT',
                  startTimeUnixNano: '5',
                  endTimeUnixNano: 7,
                  attributes: [{ key: 'n', value: { intValue: '9007199254740993' } }],
                  status: { code: 'STATUS_CODE_ERROR' },
                },
              ],
            },
          ],
        },
      ],
    });
    const s = rs?.scopeSpans[0]?.spans[0];
    expect(s).toMatchObject({
      traceId: '01'.repeat(16),
      spanId: '02'.repeat(8),
      kind: 3,
      startTimeUnixNano: 5n,
      endTimeUnixNano: 7n,
      attributes: { n: '9007199254740993' },
      status: { code: 2 },
    });
  });

  it('rejects truncated protobuf and bounds nesting', () => {
    expect(() => decodeProtobuf(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow(OtlpDecodeError);

    // A span whose attribute nests arrays 40 deep: decoded, with the deepest levels replaced.
    const varint = (n: number) => {
      const out: number[] = [];
      let v = n;
      while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
      }
      out.push(v);
      return out;
    };
    const field = (n: number, bytes: number[]) => [(n << 3) | 2, ...varint(bytes.length), ...bytes];
    let value = field(1, [0x78]); // AnyValue { string_value: "x" }
    for (let i = 0; i < 40; i++) value = field(5, field(1, value)); // AnyValue { array_value }
    const attribute = [...field(1, [0x6b]), ...field(2, value)]; // KeyValue { key: "k", value }
    const spanBytes = [
      ...field(1, Array(16).fill(1)),
      ...field(2, Array(8).fill(2)),
      ...field(9, attribute),
    ];
    const request = field(1, field(2, field(2, spanBytes))); // ResourceSpans > ScopeSpans > Span
    const [rs] = decodeProtobuf(new Uint8Array(request));
    const attr = rs?.scopeSpans[0]?.spans[0]?.attributes.k;
    expect(JSON.stringify(attr)).toContain('[nested too deeply]');
  });

  it('counts spans without valid ids as rejected', () => {
    const batch = mapResourceSpans(
      [
        {
          resource: {},
          scopeSpans: [
            {
              scope: { name: '', version: '' },
              spans: [span({}), span({}, { traceId: '0'.repeat(32) }), span({}, { spanId: 'xyz' })],
            },
          ],
        },
      ],
      {},
    );
    expect(batch.rejectedSpans).toBe(2);
    expect(batch.traces).toHaveLength(1);
  });
});
