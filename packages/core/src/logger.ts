/**
 * Structured logging for SCOPE's own operation.
 *
 * Log records never contain prompt or output content: fields that look like content are
 * replaced with their size, and every string passes through secret redaction.
 */
import { byteLength, toJsonValue } from './json.ts';
import { DEFAULT_PRIVACY_POLICY, type PrivacyPolicy, redactText } from './privacy.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Field names whose values are payload content and must never be logged verbatim. */
const CONTENT_FIELDS = new Set([
  'input',
  'output',
  'prompt',
  'completion',
  'content',
  'messages',
  'body',
  'text',
]);

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  isEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  /** Receives one formatted line per record. */
  write: (line: string, level: Exclude<LogLevel, 'silent'>) => void;
  fields?: LogFields;
  privacy?: PrivacyPolicy;
  now?: () => number;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) return fallback;
  const v = value.toLowerCase();
  return v in LEVEL_ORDER ? (v as LogLevel) : fallback;
}

function sanitize(fields: LogFields, privacy: PrivacyPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (CONTENT_FIELDS.has(key) && value !== null) {
      const size =
        typeof value === 'string'
          ? byteLength(value)
          : byteLength(JSON.stringify(toJsonValue(value)) ?? '');
      out[key] = `[omitted ${size} bytes]`;
      continue;
    }
    if (value instanceof Error) {
      out[key] = { name: value.name, message: redactText(value.message, privacy).text };
      continue;
    }
    if (typeof value === 'string') {
      out[key] = redactText(value, privacy).text;
      continue;
    }
    out[key] = toJsonValue(value);
  }
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const privacy = options.privacy ?? DEFAULT_PRIVACY_POLICY;
  const now = options.now ?? Date.now;
  const base = options.fields ?? {};

  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const clean = sanitize({ ...base, ...fields }, privacy);
    const msg = redactText(message, privacy).text;
    if (format === 'json') {
      options.write(
        JSON.stringify({ time: new Date(now()).toISOString(), level: lvl, msg, ...clean }),
        lvl,
      );
    } else {
      const extras = Object.entries(clean)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      options.write(`${lvl.padEnd(5)} ${msg}${extras ? `  ${extras}` : ''}`, lvl);
    }
  };

  return {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
    isEnabled: (l) => LEVEL_ORDER[l] >= LEVEL_ORDER[level],
  };
}

/** A logger that discards everything. */
export const silentLogger: Logger = {
  level: 'silent',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  isEnabled: () => false,
};
