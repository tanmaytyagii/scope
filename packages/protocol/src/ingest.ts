/**
 * The ingestion protocol: what SDKs send to `POST /api/v1/ingest`.
 *
 * This is the wire format of `@scope-ai/sdk`'s HttpExporter and the contract SDKs in other
 * languages implement. Records use epoch milliseconds (numbers) for times, like the SDK's
 * trace model. Unknown fields are ignored so newer SDKs can talk to older servers; changes to
 * existing fields require a new protocol version (the `scope-protocol` request header).
 */
import { z } from 'zod';
import { components, JsonObject, JsonValue } from './common.ts';
import { Attributes, EvaluationStatus, EvaluatorKind, SpanKind, SpanStatus } from './domain.ts';

export const INGEST_PROTOCOL_VERSION = 1;

export const INGEST_LIMITS = {
  /** Default request body limit; servers may configure another (SCOPE_MAX_INGEST_BYTES). */
  maxBodyBytes: 5 * 1024 * 1024,
  maxTracesPerRequest: 1000,
  /** Default spans kept per trace; excess spans are dropped and counted. */
  maxSpansPerTrace: 1000,
  maxNameLength: 512,
} as const;

const TraceId = z
  .string()
  .regex(/^[0-9a-f]{32}$/, '32 lowercase hex characters (W3C trace id)')
  .refine((id) => !/^0+$/.test(id), 'must not be all zeros');
const SpanId = z
  .string()
  .regex(/^[0-9a-f]{16}$/, '16 lowercase hex characters (W3C span id)')
  .refine((id) => !/^0+$/.test(id), 'must not be all zeros');
const EpochMs = z.number().finite().nonnegative().describe('Milliseconds since the Unix epoch.');
const Duration = z.number().finite().nonnegative();
const Name = z.string().min(1).max(INGEST_LIMITS.maxNameLength);
const Count = z.number().int().nonnegative();

const IngestErrorInfo = z.object({
  type: z.string().max(256),
  message: z.string().max(16_384),
  code: z.string().max(128).optional(),
  hint: z.string().max(2048).optional(),
  stack: z.string().max(32_768).optional(),
});

const IngestUsage = z.object({
  inputTokens: Count,
  outputTokens: Count,
  totalTokens: Count,
  cacheReadTokens: Count.optional(),
  cacheWriteTokens: Count.optional(),
  estimated: z.boolean().optional(),
});

export const IngestTrace = z
  .object({
    id: TraceId,
    runId: z.string().max(64).nullable().default(null),
    caseId: z.string().max(256).nullable().default(null),
    name: Name,
    status: SpanStatus,
    startTime: EpochMs,
    endTime: EpochMs,
    durationMs: Duration,
    input: JsonValue.nullable().default(null),
    output: JsonValue.nullable().default(null),
    metadata: JsonObject.default({}),
    error: IngestErrorInfo.nullable().default(null),
    usage: IngestUsage.optional().describe('Recomputed by the server from the spans.'),
    costUsd: z.number().nullable().optional().describe('Recomputed by the server from the spans.'),
    spanCount: Count.optional(),
    llmCallCount: Count.optional(),
  })
  .register(components, { id: 'IngestTrace' });

export const IngestSpan = z
  .object({
    traceId: TraceId,
    id: SpanId,
    parentId: SpanId.nullable().default(null),
    name: Name,
    kind: SpanKind.default('custom'),
    status: SpanStatus.default('ok'),
    statusMessage: z.string().max(16_384).nullable().default(null),
    startTime: EpochMs,
    endTime: EpochMs,
    durationMs: Duration,
    input: JsonValue.nullable().default(null),
    output: JsonValue.nullable().default(null),
    attributes: Attributes.default({}),
    events: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          time: EpochMs,
          attributes: Attributes.optional(),
        }),
      )
      .max(1000)
      .default([]),
    error: IngestErrorInfo.nullable().default(null),
    provider: z.string().max(128).nullable().default(null),
    model: z.string().max(256).nullable().default(null),
    inputTokens: Count.nullable().default(null),
    outputTokens: Count.nullable().default(null),
    costUsd: z.number().finite().nonnegative().nullable().default(null),
  })
  .register(components, { id: 'IngestSpan' });

export const IngestEvaluation = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, "_" and "-" (at most 64)'),
    traceId: TraceId,
    runId: z.string().max(64).nullable().default(null),
    spanId: SpanId.nullable().default(null),
    evaluator: Name,
    type: Name,
    kind: EvaluatorKind,
    status: EvaluationStatus,
    score: z.number().finite().min(0).max(1).nullable(),
    threshold: z.number().finite().nullable().default(null),
    reason: z.string().max(16_384),
    metadata: JsonObject.default({}),
    durationMs: Duration.default(0),
    createdAt: EpochMs,
  })
  .register(components, { id: 'IngestEvaluation' });

export const IngestRequest = z
  .object({
    project: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Project slug. Servers without authentication store traces in this project (default: the served project). With an API key it must match the key’s project, if given.',
      ),
    traces: z.array(IngestTrace).max(INGEST_LIMITS.maxTracesPerRequest),
    spans: z.array(IngestSpan).default([]),
    evaluations: z.array(IngestEvaluation).default([]),
  })
  .register(components, {
    id: 'IngestRequest',
    description:
      'Finished traces with their spans and evaluations. Each span and evaluation must belong to a trace in the same request.',
  });

export const IngestResponse = z
  .strictObject({
    project: z.string(),
    accepted: z.strictObject({
      traces: Count,
      spans: Count,
      evaluations: Count,
    }),
    rejectedTraces: Count.describe(
      'Traces whose id already belongs to another project (never overwritten).',
    ),
    droppedSpans: Count.describe('Spans beyond the per-trace limit, not stored.'),
  })
  .register(components, { id: 'IngestResponse' });

export type IngestTrace = z.output<typeof IngestTrace>;
export type IngestSpan = z.output<typeof IngestSpan>;
export type IngestEvaluation = z.output<typeof IngestEvaluation>;
export type IngestRequest = z.output<typeof IngestRequest>;
export type IngestRequestInput = z.input<typeof IngestRequest>;
export type IngestResponse = z.output<typeof IngestResponse>;
