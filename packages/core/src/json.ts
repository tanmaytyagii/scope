export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts an arbitrary JavaScript value into JSON-safe data.
 *
 * Unlike `JSON.parse(JSON.stringify(x))` this never throws: cycles, BigInts, functions,
 * symbols, errors, maps, sets and binary data become descriptive values instead.
 */
export function toJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'function':
      return `[function ${value.name || 'anonymous'}]`;
    case 'symbol':
      return value.toString();
    case 'object':
      break;
    default:
      return String(value);
  }

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';

  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  }
  if (obj instanceof Error) {
    return { name: obj.name, message: obj.message };
  }
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
    const size = obj instanceof ArrayBuffer ? obj.byteLength : obj.byteLength;
    return `[binary ${size} bytes]`;
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => toJsonValue(item, seen));
    }
    if (obj instanceof Map) {
      const out: JsonObject = {};
      for (const [k, v] of obj) out[String(k)] = toJsonValue(v, seen);
      return out;
    }
    if (obj instanceof Set) {
      return [...obj].map((item) => toJsonValue(item, seen));
    }
    const maybeToJson = (obj as { toJSON?: () => unknown }).toJSON;
    if (typeof maybeToJson === 'function') {
      return toJsonValue(maybeToJson.call(obj), seen);
    }
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      out[k] = toJsonValue(v, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** JSON.parse that returns `undefined` instead of throwing. */
export function tryParseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Stable stringify: object keys sorted, used for hashing definitions. */
export function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Renders a JSON value as display text: strings verbatim, everything else as JSON. */
export function jsonToText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
