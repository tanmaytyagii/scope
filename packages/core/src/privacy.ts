/**
 * Privacy controls applied to every captured payload: secret redaction, sensitive-field
 * masking, size bounds, and optional content suppression (see docs/decisions/0010).
 *
 * Redaction is pattern-based and therefore best-effort. For regulated data, disable content
 * capture entirely.
 */
import { byteLength, isJsonObject, type JsonValue, toJsonValue } from './json.ts';

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Optional post-match check (e.g. a Luhn checksum) to reduce false positives. */
  verify?: (match: string) => boolean;
  /** Keep a prefix of the match (e.g. "Bearer ") and redact the rest. */
  keepPrefix?: RegExp;
}

/** Always-on rules for credentials. Order matters: more specific rules first. */
export const SECRET_RULES: readonly RedactionRule[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'stripe_key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  {
    name: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'scope_api_key', pattern: /\bscope_[A-Za-z0-9]{24,}/g },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: 'bearer_token',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    keepPrefix: /^[Bb]earer\s+/,
  },
];

function luhn(digits: string): boolean {
  const ds = digits.replace(/\D/g, '');
  if (ds.length < 13 || ds.length > 19) return false;
  let total = 0;
  let double = false;
  for (let i = ds.length - 1; i >= 0; i--) {
    let d = Number(ds[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
    double = !double;
  }
  return total % 10 === 0;
}

/** Opt-in rules for personal data, enabled by name in `privacy.redact`. */
export const OPTIONAL_RULES: Readonly<Record<string, RedactionRule>> = {
  email: { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  credit_card: { name: 'credit_card', pattern: /\b(?:\d[ -]?){13,19}\b/g, verify: luhn },
  us_ssn: { name: 'us_ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  phone: {
    name: 'phone',
    pattern: /(?<![\w+])\+?\d{1,3}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g,
  },
};

export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'apikey',
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'clientsecret',
  'privatekey',
  'cookie',
  'setcookie',
  'xapikey',
];

export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

export interface PrivacyOptions {
  captureContent?: boolean;
  maxPayloadBytes?: number;
  /** Names of optional rules from OPTIONAL_RULES to enable. */
  redact?: readonly string[];
  /** Additional regular expressions to redact, as source strings. */
  patterns?: ReadonlyArray<{ name: string; pattern: string }>;
  /** Additional object keys whose values are always masked. */
  sensitiveKeys?: readonly string[];
}

export interface PrivacyPolicy {
  readonly captureContent: boolean;
  readonly maxPayloadBytes: number;
  readonly rules: readonly RedactionRule[];
  readonly sensitiveKeys: ReadonlySet<string>;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function createPrivacyPolicy(options: PrivacyOptions = {}): PrivacyPolicy {
  const rules: RedactionRule[] = [...SECRET_RULES];
  for (const name of options.redact ?? []) {
    const rule = OPTIONAL_RULES[name];
    if (!rule) {
      throw new Error(
        `Unknown redaction rule "${name}". Available: ${Object.keys(OPTIONAL_RULES).join(', ')}`,
      );
    }
    rules.push(rule);
  }
  for (const custom of options.patterns ?? []) {
    rules.push({ name: custom.name, pattern: new RegExp(custom.pattern, 'g') });
  }
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 256) {
    throw new Error('maxPayloadBytes must be an integer of at least 256');
  }
  return {
    captureContent: options.captureContent ?? true,
    maxPayloadBytes,
    rules,
    sensitiveKeys: new Set(
      [...DEFAULT_SENSITIVE_KEYS, ...(options.sensitiveKeys ?? [])].map(normalizeKey),
    ),
  };
}

export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = createPrivacyPolicy();

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function redactText(
  text: string,
  policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
): RedactionResult {
  let redactions = 0;
  let out = text;
  for (const rule of policy.rules) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (match) => {
      if (rule.verify && !rule.verify(match)) return match;
      redactions++;
      const prefix = rule.keepPrefix ? (match.match(rule.keepPrefix)?.[0] ?? '') : '';
      return `${prefix}[redacted:${rule.name}]`;
    });
  }
  return { text: out, redactions };
}

export interface CaptureResult {
  value: JsonValue | null;
  redactions: number;
  truncated: boolean;
  /** Serialized size before truncation. */
  bytes: number;
}

const TRUNCATION_MARKER = '$truncated';

export function isTruncatedPayload(
  value: unknown,
): value is { $truncated: true; originalBytes: number; preview: string } {
  return isJsonObject(value) && value[TRUNCATION_MARKER] === true;
}

function truncateString(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes / 4 || byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  // Cut by characters (always <= bytes), leaving room for the marker.
  const total = byteLength(text);
  const keep = Math.max(0, maxBytes - 64);
  return {
    text: `${text.slice(0, keep)}… [truncated: ${total.toLocaleString('en-US')} bytes total]`,
    truncated: true,
  };
}

/**
 * Prepares a value for storage according to the privacy policy. Returns `value: null` when
 * content capture is disabled.
 */
export function capture(
  input: unknown,
  policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
): CaptureResult {
  if (!policy.captureContent || input === undefined) {
    return { value: null, redactions: 0, truncated: false, bytes: 0 };
  }
  let redactions = 0;
  let truncated = false;

  const walk = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      const r = redactText(value, policy);
      redactions += r.redactions;
      const t = truncateString(r.text, policy.maxPayloadBytes);
      if (t.truncated) truncated = true;
      return t.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (isJsonObject(value)) {
      const out: Record<string, JsonValue> = {};
      for (const [key, v] of Object.entries(value)) {
        if (policy.sensitiveKeys.has(normalizeKey(key)) && v !== null && typeof v !== 'object') {
          redactions++;
          out[key] = '[redacted:sensitive_field]';
        } else {
          out[key] = walk(v);
        }
      }
      return out;
    }
    return value;
  };

  const redacted = walk(toJsonValue(input));
  const serialized = JSON.stringify(redacted) ?? 'null';
  const bytes = byteLength(serialized);
  if (bytes <= policy.maxPayloadBytes) {
    return { value: redacted, redactions, truncated, bytes };
  }
  const previewChars = Math.max(0, policy.maxPayloadBytes - 256);
  return {
    value: {
      [TRUNCATION_MARKER]: true,
      originalBytes: bytes,
      preview: serialized.slice(0, previewChars),
    },
    redactions,
    truncated: true,
    bytes,
  };
}

/** Convenience wrapper that returns only the captured value. */
export function capturePayload(input: unknown, policy?: PrivacyPolicy): JsonValue | null {
  return capture(input, policy).value;
}
