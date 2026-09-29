/**
 * `POST /v1/traces` — OTLP/HTTP trace ingestion. Any OpenTelemetry SDK or collector can export
 * to SCOPE by pointing its OTLP endpoint at the server (`OTEL_EXPORTER_OTLP_ENDPOINT`); the path
 * is the one the OTLP specification defines, so no custom path is needed.
 *
 * Accepts binary protobuf and JSON, optionally gzip-compressed. Authentication, projects,
 * privacy and limits are the same as `POST /api/v1/ingest`. Responses follow the OTLP
 * specification: 200 with an `ExportTraceServiceResponse`, carrying `partial_success` when spans
 * were rejected.
 */
import { gunzipSync } from 'node:zlib';
import { ErrorCodes, type JsonObject, ScopeError } from '@scope-ai/core';
import type { Project, SpanBatch } from '@scope-ai/storage';
import { limitSpans, prepareSpan, structure, targetProject } from '../ingest.ts';
import type { AppContext, Deps } from '../types.ts';
import {
  decodeJson,
  decodeProtobuf,
  encodeProtobufResponse,
  OtlpDecodeError,
  type OtlpResourceSpans,
} from './decode.ts';
import { mapResourceSpans } from './map.ts';

/** Compressed requests may expand to this multiple of the request size limit. */
const DECOMPRESSED_FACTOR = 4;

function contentType(c: AppContext): 'protobuf' | 'json' {
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type === 'application/x-protobuf' || type === 'application/protobuf') return 'protobuf';
  if (type === 'application/json') return 'json';
  throw new ScopeError(
    ErrorCodes.unsupportedMediaType,
    `OTLP requests must be application/x-protobuf or application/json, not "${type || 'none'}"`,
    {
      hint: 'Use an OTLP/HTTP exporter (protobuf or JSON). OTLP/gRPC is not supported: set OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf.',
    },
  );
}

async function body(c: AppContext, deps: Deps): Promise<Uint8Array> {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  const encoding = (c.req.header('content-encoding') ?? 'identity').trim().toLowerCase();
  if (encoding === 'identity' || encoding === '') return raw;
  if (encoding !== 'gzip') {
    throw new ScopeError(
      ErrorCodes.unsupportedMediaType,
      `Content-Encoding "${encoding}" is not supported`,
      { hint: 'Send the body uncompressed or gzip-compressed.' },
    );
  }
  const limit = deps.maxIngestBytes * DECOMPRESSED_FACTOR;
  try {
    return gunzipSync(raw, { maxOutputLength: limit });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      deps.metrics.ingestRejected.inc({ reason: 'too_large' });
      throw new ScopeError(
        ErrorCodes.payloadTooLarge,
        `The decompressed request exceeds ${limit.toLocaleString('en-US')} bytes`,
        { hint: 'Export smaller batches (OTEL_BSP_MAX_EXPORT_BATCH_SIZE).' },
      );
    }
    throw new ScopeError(ErrorCodes.badRequest, 'The gzip-compressed body could not be read', {
      hint: 'Check the exporter’s compression setting.',
    });
  }
}

function decode(bytes: Uint8Array, kind: 'protobuf' | 'json'): OtlpResourceSpans[] {
  try {
    if (kind === 'protobuf') return decodeProtobuf(bytes);
    return decodeJson(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch (error) {
    const reason =
      error instanceof OtlpDecodeError || error instanceof SyntaxError
        ? error.message
        : 'malformed request';
    throw new ScopeError(
      ErrorCodes.badRequest,
      `The OTLP ${kind === 'protobuf' ? 'protobuf' : 'JSON'} request could not be decoded: ${reason}`,
      {
        hint: 'Send an ExportTraceServiceRequest from an OpenTelemetry OTLP/HTTP exporter, and make sure Content-Type matches the encoding.',
      },
    );
  }
}

export async function handleOtlpTraces(c: AppContext, deps: Deps): Promise<Response> {
  const kind = contentType(c);
  let batch: OtlpResourceSpans[];
  try {
    batch = decode(await body(c, deps), kind);
  } catch (error) {
    deps.metrics.ingestRejected.inc({ reason: 'otlp_decode' });
    throw error;
  }
  const mapped = mapResourceSpans(batch, deps.pricing);

  // Group by the project each resource names (`scope.project`), checked like /api/v1/ingest.
  const byProject = new Map<string, { project: Project; batches: SpanBatch[]; spans: number }>();
  let dropped = 0;
  for (const trace of mapped.traces) {
    const project = await targetProject(c, deps, trace.project ?? undefined);
    const entry = byProject.get(project.id) ?? { project, batches: [], spans: 0 };
    const limited = limitSpans(trace.spans, deps.maxSpansPerTrace);
    dropped += limited.dropped;
    entry.batches.push({
      traceId: trace.traceId,
      spans: limited.kept.map((s) => prepareSpan(s, trace.traceId, deps.privacy)),
      metadata: structure(trace.metadata, deps.privacy) as JsonObject,
    });
    entry.spans += limited.kept.length;
    byProject.set(project.id, entry);
  }

  let rejected = mapped.rejectedSpans;
  for (const { project, batches } of byProject.values()) {
    const result = await deps.store.ingestSpans(project.id, batches, deps.maxSpansPerTrace);
    dropped += result.dropped;
    deps.metrics.ingestedTraces.inc({}, result.traces);
    deps.metrics.ingestedSpans.inc({}, result.spans);
    if (result.rejectedSpans) {
      deps.metrics.ingestRejected.inc({ reason: 'foreign_trace' });
      rejected += result.rejectedSpans;
    }
    deps.logger.debug('ingested OTLP spans', {
      project: project.slug,
      traces: result.traces,
      spans: result.spans,
      dropped: result.dropped,
    });
  }
  if (dropped) deps.metrics.droppedSpans.inc({}, dropped);
  if (mapped.rejectedSpans)
    deps.metrics.ingestRejected.inc({ reason: 'invalid_span' }, mapped.rejectedSpans);

  const message = rejected
    ? `${rejected} span(s) rejected: invalid ids, or trace ids that belong to another project`
    : '';
  if (kind === 'protobuf') {
    return c.body(encodeProtobufResponse(rejected, message), 200, {
      'content-type': 'application/x-protobuf',
    });
  }
  return c.json(
    rejected ? { partialSuccess: { rejectedSpans: String(rejected), errorMessage: message } } : {},
  );
}
