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
  /** Maximum traces per request. */
  maxBatchTraces?: number;
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

export class HttpExporter implements TraceExporter {
  readonly #options: Required<
    Omit<HttpExporterOptions, 'apiKey' | 'project' | 'logger' | 'fetch'>
  > &
    Pick<HttpExporterOptions, 'apiKey' | 'project'>;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  #queue: TraceBundle[] = [];
  #queuedSpans = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;
  #warnedDrop = false;
  #warnedUnreachable = false;
  readonly stats: HttpExporterStats = { exportedTraces: 0, droppedTraces: 0, failedRequests: 0 };

  constructor(options: HttpExporterOptions) {
    this.#options = {
      url: options.url.replace(/\/+$/, ''),
      apiKey: options.apiKey,
      project: options.project,
      maxQueueSpans: options.maxQueueSpans ?? 2048,
      maxBatchTraces: options.maxBatchTraces ?? 50,
      flushIntervalMs: options.flushIntervalMs ?? 1000,
      maxRetries: options.maxRetries ?? 3,
      timeoutMs: options.timeoutMs ?? 10_000,
    };
    this.#logger = options.logger ?? silentLogger;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  export(bundle: TraceBundle): void {
    const size = bundle.spans.length;
    if (this.#queuedSpans + size > this.#options.maxQueueSpans) {
      this.stats.droppedTraces++;
      if (!this.#warnedDrop) {
        this.#warnedDrop = true;
        this.#logger.warn('SCOPE export queue is full; dropping traces', {
          maxQueueSpans: this.#options.maxQueueSpans,
        });
      }
      return;
    }
    this.#queue.push(bundle);
    this.#queuedSpans += size;
    if (this.#queue.length >= this.#options.maxBatchTraces) void this.#drain();
    else this.#schedule();
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

  async #drain(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = (async () => {
      while (this.#queue.length > 0) {
        const batch = this.#queue.splice(0, this.#options.maxBatchTraces);
        this.#queuedSpans -= batch.reduce((n, b) => n + b.spans.length, 0);
        await this.#send(batch);
      }
    })().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #send(batch: TraceBundle[]): Promise<void> {
    const body = JSON.stringify({
      project: this.#options.project,
      traces: batch.map((b) => b.trace),
      spans: batch.flatMap((b) => b.spans),
      evaluations: batch.flatMap((b) => b.evaluations),
    });
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
          this.stats.failedRequests++;
          this.stats.droppedTraces += batch.length;
          this.#logger.error('SCOPE server rejected traces', {
            status: response.status,
            response: text.slice(0, 300),
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
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
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
    await this.#drain();
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}
