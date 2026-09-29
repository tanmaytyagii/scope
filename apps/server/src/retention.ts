/**
 * Scheduled retention for `scope server`: deletes runs and application traces older than the
 * configured age, in every project, when the server starts and every hour after. Configured by
 * the operator (SCOPE_RETENTION); off unless set.
 */
import type { Logger } from '@scope-ai/core';
import type { Store } from '@scope-ai/storage';
import type { ServerMetrics } from './metrics.ts';

export interface RetentionOptions {
  store: Store;
  logger: Logger;
  metrics: ServerMetrics;
  /** Delete what started longer ago than this. */
  maxAgeMs: number;
  intervalMs?: number;
}

export interface Retention {
  /** Prunes once now; resolves when done. Runs never overlap. */
  runOnce(): Promise<void>;
  stop(): void;
}

export function startRetention(options: RetentionOptions): Retention {
  const { store, logger, metrics, maxAgeMs } = options;
  let running: Promise<void> | null = null;
  const runOnce = () => {
    running ??= (async () => {
      const started = Date.now();
      try {
        const deleted = await store.prune({ projectIds: null, before: started - maxAgeMs });
        metrics.pruned.inc({ kind: 'runs' }, deleted.runs);
        metrics.pruned.inc({ kind: 'traces' }, deleted.traces + deleted.runTraces);
        metrics.pruned.inc({ kind: 'spans' }, deleted.spans);
        if (deleted.runs + deleted.traces > 0)
          logger.info('retention deleted old data', {
            maxAgeMs,
            runs: deleted.runs,
            traces: deleted.traces + deleted.runTraces,
            spans: deleted.spans,
            evaluations: deleted.evaluations,
            durationMs: Date.now() - started,
          });
      } catch (error) {
        logger.error('retention failed; it will be tried again', { error });
      } finally {
        running = null;
      }
    })();
    return running;
  };
  void runOnce();
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 3_600_000);
  timer.unref?.();
  return { runOnce, stop: () => clearInterval(timer) };
}
