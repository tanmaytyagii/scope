import type * as core from '@scope-ai/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type * as domain from './domain.ts';
import { IngestRequest } from './ingest.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { TracesQuery } from './queries.ts';
import { API_BASE, ROUTES } from './routes.ts';

type Out<T extends z.ZodType> = z.output<T>;

describe('domain schemas mirror @scope-ai/core', () => {
  it('accept every core value (checked by the type checker)', () => {
    expectTypeOf<core.Usage>().toExtend<Out<typeof domain.Usage>>();
    expectTypeOf<core.ErrorInfo>().toExtend<Out<typeof domain.ErrorInfo>>();
    expectTypeOf<core.GitInfo>().toExtend<Out<typeof domain.GitInfo>>();
    expectTypeOf<core.DatasetInfo>().toExtend<Out<typeof domain.DatasetInfo>>();
    expectTypeOf<core.RunSummary>().toExtend<Out<typeof domain.RunSummary>>();
    expectTypeOf<core.GateResult>().toExtend<Out<typeof domain.GateResult>>();
    expectTypeOf<core.MetricDelta>().toExtend<Out<typeof domain.MetricDelta>>();
    expectTypeOf<core.CaseSnapshot>().toExtend<Out<typeof domain.CaseSnapshot>>();
    expectTypeOf<core.CaseChange>().toExtend<Out<typeof domain.CaseChange>>();
    expectTypeOf<core.SpanKind>().toEqualTypeOf<Out<typeof domain.SpanKind>>();
    expectTypeOf<core.EvaluationStatus>().toEqualTypeOf<Out<typeof domain.EvaluationStatus>>();
    expectTypeOf<core.RunStatus>().toEqualTypeOf<Out<typeof domain.RunStatus>>();
    expectTypeOf<core.GateStatus>().toEqualTypeOf<Out<typeof domain.GateStatus>>();
  });

  it('ingestion accepts the SDK’s records', () => {
    type Input = z.input<typeof IngestRequest>;
    expectTypeOf<core.TraceRecord>().toExtend<Input['traces'][number]>();
    expectTypeOf<core.SpanRecord>().toExtend<NonNullable<Input['spans']>[number]>();
    expectTypeOf<core.EvaluationRecord>().toExtend<NonNullable<Input['evaluations']>[number]>();
  });
});

describe('ingest request', () => {
  const trace = {
    id: 'a'.repeat(32),
    name: 'answer',
    status: 'ok',
    startTime: 1000,
    endTime: 1010,
    durationMs: 10,
  };

  it('fills defaults and ignores unknown fields', () => {
    const parsed = IngestRequest.parse({ traces: [{ ...trace, futureField: 1 }] });
    expect(parsed.traces[0]).toMatchObject({ runId: null, metadata: {}, input: null });
    expect(parsed.traces[0]).not.toHaveProperty('futureField');
    expect(parsed.spans).toEqual([]);
  });

  it('rejects malformed ids with a path', () => {
    const result = IngestRequest.safeParse({ traces: [{ ...trace, id: 'XYZ' }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['traces', 0, 'id']);
  });

  it('rejects all-zero trace ids', () => {
    expect(IngestRequest.safeParse({ traces: [{ ...trace, id: '0'.repeat(32) }] }).success).toBe(
      false,
    );
  });
});

describe('queries', () => {
  it('coerce numbers and validate enums', () => {
    expect(TracesQuery.parse({ limit: '25', sort: 'slowest' })).toEqual({
      limit: 25,
      sort: 'slowest',
    });
    expect(TracesQuery.safeParse({ limit: '500' }).success).toBe(false);
    expect(TracesQuery.safeParse({ sort: 'random' }).success).toBe(false);
  });
});

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument() as {
    openapi: string;
    paths: Record<string, Record<string, { operationId: string; responses: object }>>;
    components: { schemas: Record<string, unknown> };
  };

  it('describes every route', () => {
    expect(doc.openapi).toBe('3.1.0');
    for (const route of ROUTES) {
      const op = doc.paths[`${API_BASE}${route.path}`]?.[route.method];
      expect(op?.operationId, `${route.method} ${route.path}`).toBe(route.operationId);
    }
  });

  it('has unique operation ids', () => {
    const ids = ROUTES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every $ref', () => {
    const refs = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (k === '$ref' && typeof v === 'string') refs.add(v);
          else walk(v);
        }
      }
    };
    walk(doc);
    expect(refs.size).toBeGreaterThan(10);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\/[A-Za-z]+$/);
      expect(doc.components.schemas[ref.split('/').pop() as string], ref).toBeDefined();
    }
  });

  it('leaves no strictness or JSON Schema dialect markers in the output', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"additionalProperties":false');
    expect(text).not.toContain('$schema');
  });
});
