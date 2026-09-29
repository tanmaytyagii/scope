/**
 * Trace exporters.
 *
 * The HTTP exporter is built for use inside production applications: it batches, bounds its
 * memory, retries with backoff, and never throws into or blocks the host application. When the
 * queue is full it drops traces and says so once.
 */
import {
  formatDuration,
  type Logger,
  SCOPE_VERSION,
  silentLogger,
  type TraceBundle,
} from '@scope-ai/core';
import type { TraceExporter } from './tracer.ts';

/** Keeps traces in memory. For tests. */
export class MemoryExporter implements TraceExporter {
  readonly bundles: TraceBundle[] = [];
  export(bundle: TraceBundle): void {
    this.bundles.push(bundle);
  }
  clear(): void {
    this.bundles.length = 0;
  }
}

/** Prints a one-line summary per trace to stderr. For local debugging. */
export class ConsoleExporter implements TraceExporter {
  readonly #write: (line: string) => void;
  constructor(write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)) {
    this.#write = write;
  }
  export(bundle: TraceBundle): void {
    const t = bundle.trace;
    const evals = bundle.evaluations.length
      ? ` · evals ${bundle.evaluations.filter((e) => e.status === 'passed').length}/${bundle.evaluations.length} passed`
      : '';
    this.#write(
      `[scope] ${t.status === 'ok' ? 'ok ' : 'ERR'} ${t.name} ${t.id.slice(0, 7)} ${formatDuration(t.durationMs)} · ${t.spanCount} spans · ${t.usage.totalTokens} tokens${evals}`,
    );
  }
}

export interface HttpExporterOptions {
  /** Base URL of a SCOPE server, e.g. http://127.0.0.1:4700. */
  url: string;
  apiKey?: string | undefined;
  /** Project slug, used by servers running without authentication. */
  project?: string | undefined;
  /** Maximum spans held in memory awaiting export. */
  maxQueueSpans?: number;
  /** Maximum serialized bytes held in memory awaiting export. */
  maxQueueBytes?: number;
  /** Maximum traces per request. */
  maxBatchTraces?: number;
  /**
   * Maximum request body size. Keep it at or below the server's limit (`SCOPE_MAX_INGEST_BYTES`,
   * 5 MiB by default); a trace larger than this is dropped and counted rather than sent.
   */
  maxBatchBytes?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  logger?: Logger;
  fetch?: typeof fetch;
}

export interface HttpExporterStats {
  exportedTraces: number;
  droppedTraces: number;
  failedRequests: number;
}

/** A queued trace, serialized once when it is queued: its size bounds memory and requests. */
interface Queued {
  id: string;
  trace: string;
  spans: string;
  evaluations: string;
  spanCount: number;
  bytes: number;
}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');
const joined = (items: readonly unknown[]) => items.map((item) => JSON.stringify(item)).join(',');

export class HttpExporter implements TraceExporter {
  readonly #options: Required<
    Omit<HttpExporterOptions, 'apiKey' | 'project' | 'logger' | 'fetch'>
  > &
    Pick<HttpExporterOptions, 'apiKey' | 'project'>;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  #queue: Queued[] = [];
  #queuedSpans = 0;
  #queuedBytes = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;
  /** Number of callers awaiting flush(); while > 0, retry timers keep the process alive. */
  #flushing = 0;
  #backoff: ReturnType<typeof setTimeout> | null = null;
  #warnedDrop = false;
  #warnedOversized = false;
  #warnedUnreachable = false;
  readonly stats: HttpExporterStats = { exportedTraces: 0, droppedTraces: 0, failedRequests: 0 };

  constructor(options: HttpExporterOptions) {
    this.#options = {
      url: options.url.replace(/\/+$/, ''),
      apiKey: options.apiKey,
      project: options.project,
      maxQueueSpans: options.maxQueueSpans ?? 2048,
      maxQueueBytes: options.maxQueueBytes ?? 32 * 1024 * 1024,
      maxBatchTraces: options.maxBatchTraces ?? 50,
      maxBatchBytes: options.maxBatchBytes ?? 4 * 1024 * 1024,
      flushIntervalMs: options.flushIntervalMs ?? 1000,
      maxRetries: options.maxRetries ?? 3,
      timeoutMs: options.timeoutMs ?? 10_000,
    };
    this.#logger = options.logger ?? silentLogger;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  export(bundle: TraceBundle): void {
    const item: Queued = {
      id: bundle.trace.id,
      trace: JSON.stringify(bundle.trace),
      spans: joined(bundle.spans),
      evaluations: joined(bundle.evaluations),
      spanCount: bundle.spans.length,
      bytes: 0,
    };
    item.bytes = byteLength(item.trace) + byteLength(item.spans) + byteLength(item.evaluations);
    if (item.bytes > this.#options.maxBatchBytes) {
      this.#dropOversized(item);
      return;
    }
    if (
      this.#queuedSpans + item.spanCount > this.#options.maxQueueSpans ||
      this.#queuedBytes + item.bytes > this.#options.maxQueueBytes
    ) {
      this.stats.droppedTraces++;
      if (!this.#warnedDrop) {
        this.#warnedDrop = true;
        this.#logger.warn('SCOPE export queue is full; dropping traces', {
          maxQueueSpans: this.#options.maxQueueSpans,
          maxQueueBytes: this.#options.maxQueueBytes,
        });
      }
      return;
    }
    this.#queue.push(item);
    this.#queuedSpans += item.spanCount;
    this.#queuedBytes += item.bytes;
    if (this.#queue.length >= this.#options.maxBatchTraces) void this.#drain();
    else this.#schedule();
  }

  #dropOversized(item: Queued): void {
    this.stats.droppedTraces++;
    if (this.#warnedOversized) return;
    this.#warnedOversized = true;
    this.#logger.warn('SCOPE dropped a trace too large to send', {
      traceId: item.id,
      bytes: item.bytes,
      maxBatchBytes: this.#options.maxBatchBytes,
      hint: 'Lower privacy.maxPayloadBytes, or raise the server limit (SCOPE_MAX_INGEST_BYTES) and maxBatchBytes together.',
    });
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#drain();
    }, this.#options.flushIntervalMs);
    // Never keep the host process alive just to export.
    this.#timer.unref?.();
  }

  /** Takes the next batch off the queue: at most maxBatchTraces traces and maxBatchBytes. */
  #nextBatch(): Queued[] {
    const batch: Queued[] = [];
    let bytes = 0;
    while (this.#queue.length > 0 && batch.length < this.#options.maxBatchTraces) {
      const next = this.#queue[0] as Queued;
      if (batch.length > 0 && bytes + next.bytes > this.#options.maxBatchBytes) break;
      this.#queue.shift();
      this.#queuedSpans -= next.spanCount;
      this.#queuedBytes -= next.bytes;
      bytes += next.bytes;
      batch.push(next);
    }
    return batch;
  }

  async #drain(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = (async () => {
      while (this.#queue.length > 0) await this.#send(this.#nextBatch());
    })().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  #body(batch: readonly Queued[]): string {
    const list = (parts: string[]) => parts.filter((part) => part !== '').join(',');
    const project =
      this.#options.project === undefined
        ? ''
        : `"project":${JSON.stringify(this.#options.project)},`;
    return (
      `{${project}"traces":[${list(batch.map((b) => b.trace))}],` +
      `"spans":[${list(batch.map((b) => b.spans))}],` +
      `"evaluations":[${list(batch.map((b) => b.evaluations))}]}`
    );
  }

  async #send(batch: Queued[]): Promise<void> {
    const body = this.#body(batch);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `scope-sdk-js/${SCOPE_VERSION}`,
      'scope-protocol': '1',
    };
    if (this.#options.apiKey) headers.authorization = `Bearer ${this.#options.apiKey}`;

    for (let attempt = 0; attempt <= this.#options.maxRetries; attempt++) {
      try {
        const response = await this.#fetch(`${this.#options.url}/api/v1/ingest`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.#options.timeoutMs),
        });
        if (response.ok) {
          this.stats.exportedTraces += batch.length;
          return;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          const text = await response.text().catch(() => '');
          // One oversized or invalid trace must not take the rest of its batch with it: send the
          // halves separately until the traces the server refuses are on their own.
          if (batch.length > 1 && splittable(response.status, text)) {
            const half = Math.ceil(batch.length / 2);
            await this.#send(batch.slice(0, half));
            await this.#send(batch.slice(half));
            return;
          }
          this.stats.failedRequests++;
          this.stats.droppedTraces += batch.length;
          this.#logger.error('SCOPE server rejected traces', {
            status: response.status,
            traces: batch.length,
            ...(batch.length === 1 ? { traceId: batch[0]?.id } : {}),
            response: text.slice(0, 300),
            ...(response.status === 401 || response.status === 403
              ? { hint: 'Check SCOPE_API_KEY: an ingest-scoped key for this project.' }
              : {}),
          });
          return;
        }
      } catch (error) {
        if (!this.#warnedUnreachable && attempt === this.#options.maxRetries) {
          this.#warnedUnreachable = true;
          this.#logger.warn(
            `SCOPE server not reachable at ${this.#options.url}; traces are being dropped`,
            {
              error,
              hint: 'Start a local server with `scope ui`, or set SCOPE_URL.',
            },
          );
        }
      }
      if (attempt < this.#options.maxRetries) {
        const delay = Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2);
        await new Promise((resolve) => {
          this.#backoff = setTimeout(resolve, delay);
          // Background exports never keep the process alive; an awaited flush() does, so a
          // caller's `await tracer.shutdown()` finishes instead of the process exiting mid-retry.
          if (this.#flushing === 0) this.#backoff.unref?.();
        });
        this.#backoff = null;
      }
    }
    this.stats.failedRequests++;
    this.stats.droppedTraces += batch.length;
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#flushing++;
    this.#backoff?.ref?.();
    try {
      await this.#drain();
    } finally {
      this.#flushing--;
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

/**
 * Whether splitting a rejected batch can help: the body was too large, or the server named the
 * records it refused (`details.issues`). Other rejections (authentication, protocol version)
 * would fail for every half too.
 */
function splittable(status: number, body: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  try {
    const details = (JSON.parse(body) as { error?: { details?: { issues?: unknown } } }).error
      ?.details;
    return Array.isArray(details?.issues) && details.issues.length > 0;
  } catch {
    return false;
  }
}
