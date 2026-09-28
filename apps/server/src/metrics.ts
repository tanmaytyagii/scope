/**
 * Prometheus metrics for the server itself, in the text exposition format. Label values are
 * bounded (route patterns, not raw paths) so cardinality stays small.
 */
import { SCOPE_VERSION } from '@scope-ai/core';

type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map(
      (k) =>
        `${k}="${String(labels[k]).replace(/["\\\n]/g, (ch) => (ch === '\n' ? '\\n' : `\\${ch}`))}"`,
    )
    .join(',');
}

class Counter {
  readonly name: string;
  readonly help: string;
  readonly #values = new Map<string, number>();
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.#values.set(k, (this.#values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.#values.get(key(labels)) ?? 0;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.#values.size === 0) lines.push(`${this.name} 0`);
    for (const [k, v] of this.#values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: readonly number[];
  readonly #series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, buckets: readonly number[] = DURATION_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    let s = this.#series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) (s.counts[i] as number)++;
    });
    s.sum += value;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.#series) {
      const prefix = k ? `${k},` : '';
      this.buckets.forEach((b, i) => {
        lines.push(`${this.name}_bucket{${prefix}le="${b}"} ${s.counts[i]}`);
      });
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class ServerMetrics {
  readonly startedAt = Date.now();
  readonly httpRequests = new Counter(
    'scope_http_requests_total',
    'HTTP requests by route and status.',
  );
  readonly httpDuration = new Histogram(
    'scope_http_request_duration_seconds',
    'HTTP request duration by route.',
  );
  readonly ingestedTraces = new Counter(
    'scope_ingested_traces_total',
    'Traces stored by ingestion.',
  );
  readonly ingestedSpans = new Counter('scope_ingested_spans_total', 'Spans stored by ingestion.');
  readonly ingestedEvaluations = new Counter(
    'scope_ingested_evaluations_total',
    'Evaluations stored by ingestion.',
  );
  readonly ingestRejected = new Counter(
    'scope_ingest_rejected_total',
    'Ingestion requests or traces rejected, by reason.',
  );
  readonly droppedSpans = new Counter(
    'scope_ingest_dropped_spans_total',
    'Spans dropped because a trace exceeded the per-trace span limit.',
  );
  readonly unexpectedErrors = new Counter(
    'scope_unexpected_errors_total',
    'Requests that failed with an unexpected (500) error.',
  );

  render(): string {
    return `${[
      '# HELP scope_build_info SCOPE version.',
      '# TYPE scope_build_info gauge',
      `scope_build_info{version="${SCOPE_VERSION}"} 1`,
      '# HELP scope_process_start_time_seconds Server start time.',
      '# TYPE scope_process_start_time_seconds gauge',
      `scope_process_start_time_seconds ${Math.floor(this.startedAt / 1000)}`,
      this.httpRequests.render(),
      this.httpDuration.render(),
      this.ingestedTraces.render(),
      this.ingestedSpans.render(),
      this.ingestedEvaluations.render(),
      this.ingestRejected.render(),
      this.droppedSpans.render(),
      this.unexpectedErrors.render(),
    ].join('\n')}\n`;
  }
}
