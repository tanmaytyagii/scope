import {
  createLogger,
  type Logger,
  type PriceTable,
  type PrivacyOptions,
  parseLogLevel,
} from '@scope-ai/core';
import { ConsoleExporter, HttpExporter } from './exporters.ts';
import { type TraceExporter, Tracer } from './tracer.ts';

export * from './exporters.ts';
export * from './span.ts';
export * from './tracer.ts';

export const DEFAULT_SCOPE_URL = 'http://127.0.0.1:4700';

export interface CreateTracerOptions {
  /** Where traces go. Defaults to HTTP export to SCOPE_URL (or a local `scope ui` server). */
  exporter?: TraceExporter;
  /** Project slug, for servers running without authentication. Defaults to SCOPE_PROJECT. */
  project?: string;
  privacy?: PrivacyOptions;
  pricing?: PriceTable;
  logger?: Logger;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Creates a tracer configured from the environment:
 *
 * | Variable              | Effect                                                   |
 * | --------------------- | -------------------------------------------------------- |
 * | SCOPE_URL             | SCOPE server to export to (default http://127.0.0.1:4700) |
 * | SCOPE_API_KEY         | API key for servers that require authentication          |
 * | SCOPE_PROJECT         | Project slug for servers without authentication          |
 * | SCOPE_EXPORTER=console| Print traces to stderr instead of exporting              |
 * | SCOPE_CAPTURE_CONTENT | "false" to record structure and metrics but no content   |
 * | SCOPE_LOG_LEVEL       | SDK log level (default "warn")                           |
 */
export function createTracer(options: CreateTracerOptions = {}): Tracer {
  const env = options.env ?? process.env;
  const logger =
    options.logger ??
    createLogger({
      level: parseLogLevel(env.SCOPE_LOG_LEVEL, 'warn'),
      format: 'pretty',
      write: (line) => process.stderr.write(`[scope] ${line}\n`),
    });
  const privacy: PrivacyOptions = { ...options.privacy };
  const capture = env.SCOPE_CAPTURE_CONTENT;
  if (capture !== undefined && capture !== '') {
    privacy.captureContent = !['0', 'false', 'no', 'off'].includes(capture.toLowerCase());
  }
  const exporter =
    options.exporter ??
    (env.SCOPE_EXPORTER === 'console'
      ? new ConsoleExporter()
      : new HttpExporter({
          url: env.SCOPE_URL || DEFAULT_SCOPE_URL,
          apiKey: env.SCOPE_API_KEY,
          project: options.project ?? env.SCOPE_PROJECT,
          logger,
        }));
  return new Tracer({
    exporter,
    privacy,
    ...(options.pricing ? { pricing: options.pricing } : {}),
    logger,
  });
}
export * from './instrument.ts';
