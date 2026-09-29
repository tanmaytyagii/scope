/**
 * Decoding OTLP/HTTP trace export requests (opentelemetry-proto `ExportTraceServiceRequest`) in
 * both encodings the specification defines: binary protobuf and JSON. Both decode into one
 * neutral shape; mapping to SCOPE's model happens in map.ts.
 *
 * The protobuf reader implements only what the trace request uses — varints, 64/32-bit fixed
 * values and length-delimited fields — skips unknown fields as the format requires, checks every
 * length against the buffer, and bounds value nesting, because the input is untrusted.
 */

export type OtlpValue =
  | string
  | number
  | boolean
  | null
  | OtlpValue[]
  | { [key: string]: OtlpValue };
export type OtlpAttributes = Record<string, OtlpValue>;

export interface OtlpEvent {
  timeUnixNano: bigint;
  name: string;
  attributes: OtlpAttributes;
}

export interface OtlpSpan {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters. */
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OTel SpanKind: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer. */
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: OtlpAttributes;
  events: OtlpEvent[];
  /** OTel StatusCode: 0 unset, 1 ok, 2 error. */
  status: { code: number; message: string };
}

export interface OtlpScopeSpans {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: OtlpAttributes;
  scopeSpans: OtlpScopeSpans[];
}

export class OtlpDecodeError extends Error {}

/** Deeper values are stored as a marker; real attributes are never nested this far. */
const MAX_VALUE_DEPTH = 16;

// ─── protobuf ────────────────────────────────────────────────────────────────────────────────

class Reader {
  readonly buf: Uint8Array;
  readonly end: number;
  pos: number;
  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.end) throw new OtlpDecodeError('truncated varint');
      const byte = this.buf[this.pos++] as number;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
    throw new OtlpDecodeError('varint longer than 10 bytes');
  }

  uint(): number {
    return Number(BigInt.asUintN(64, this.varint()));
  }

  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new OtlpDecodeError('truncated fixed64');
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getBigUint64(0, true);
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new OtlpDecodeError('truncated double');
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  /** A length-delimited field as a sub-reader over the same buffer. */
  sub(): Reader {
    const length = this.uint();
    if (length > this.end - this.pos) throw new OtlpDecodeError('length exceeds the message');
    const reader = new Reader(this.buf, this.pos, this.pos + length);
    this.pos += length;
    return reader;
  }

  bytes(): Uint8Array {
    const r = this.sub();
    return this.buf.subarray(r.pos, r.end);
  }

  string(): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(this.bytes());
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.sub();
    else if (wire === 5) this.pos += 4;
    else throw new OtlpDecodeError(`unsupported wire type ${wire}`);
    if (this.pos > this.end) throw new OtlpDecodeError('truncated field');
  }

  /** Iterates the fields of this message. */
  *fields(): Generator<[field: number, wire: number]> {
    while (!this.done) {
      const tag = this.uint();
      yield [tag >>> 3, tag & 7];
    }
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function readAnyValue(r: Reader, depth: number): OtlpValue {
  if (depth > MAX_VALUE_DEPTH) return '[nested too deeply]';
  let value: OtlpValue = null;
  for (const [field, wire] of r.fields()) {
    if (field === 1 && wire === 2) value = r.string();
    else if (field === 2 && wire === 0) value = r.varint() !== 0n;
    else if (field === 3 && wire === 0) value = int64(BigInt.asIntN(64, r.varint()));
    else if (field === 4 && wire === 1) value = r.double();
    else if (field === 5 && wire === 2) {
      const list: OtlpValue[] = [];
      const a = r.sub();
      for (const [f, w] of a.fields()) {
        if (f === 1 && w === 2) list.push(readAnyValue(a.sub(), depth + 1));
        else a.skip(w);
      }
      value = list;
    } else if (field === 6 && wire === 2) value = readKeyValues(r.sub(), 1, depth + 1);
    else if (field === 7 && wire === 2) value = Buffer.from(r.bytes()).toString('base64');
    else r.skip(wire);
  }
  return value;
}

/** Reads the repeated KeyValue at `field` of a message (the whole reader). */
function readKeyValues(r: Reader, field: number, depth = 0): OtlpAttributes {
  const out: OtlpAttributes = {};
  for (const [f, w] of r.fields()) {
    if (f !== field || w !== 2) {
      r.skip(w);
      continue;
    }
    const kv = r.sub();
    let key = '';
    let value: OtlpValue = null;
    for (const [kf, kw] of kv.fields()) {
      if (kf === 1 && kw === 2) key = kv.string();
      else if (kf === 2 && kw === 2) value = readAnyValue(kv.sub(), depth);
      else kv.skip(kw);
    }
    if (key) out[key] = value;
  }
  return out;
}

function int64(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function readKeyValue(r: Reader): [string, OtlpValue] {
  let key = '';
  let value: OtlpValue = null;
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) key = r.string();
    else if (f === 2 && w === 2) value = readAnyValue(r.sub(), 0);
    else r.skip(w);
  }
  return [key, value];
}

function readEvent(r: Reader): OtlpEvent {
  const event: OtlpEvent = { timeUnixNano: 0n, name: '', attributes: {} };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 1) event.timeUnixNano = r.fixed64();
    else if (f === 2 && w === 2) event.name = r.string();
    else if (f === 3 && w === 2) {
      const [k, v] = readKeyValue(r.sub());
      if (k) event.attributes[k] = v;
    } else r.skip(w);
  }
  return event;
}

function readSpan(r: Reader): OtlpSpan {
  const span: OtlpSpan = {
    traceId: '',
    spanId: '',
    parentSpanId: null,
    name: '',
    kind: 0,
    startTimeUnixNano: 0n,
    endTimeUnixNano: 0n,
    attributes: {},
    events: [],
    status: { code: 0, message: '' },
  };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) span.traceId = hex(r.bytes());
    else if (f === 2 && w === 2) span.spanId = hex(r.bytes());
    else if (f === 4 && w === 2) {
      const parent = hex(r.bytes());
      span.parentSpanId = parent || null;
    } else if (f === 5 && w === 2) span.name = r.string();
    else if (f === 6 && w === 0) span.kind = r.uint();
    else if (f === 7 && w === 1) span.startTimeUnixNano = r.fixed64();
    else if (f === 8 && w === 1) span.endTimeUnixNano = r.fixed64();
    else if (f === 9 && w === 2) {
      const [k, v] = readKeyValue(r.sub());
      if (k) span.attributes[k] = v;
    } else if (f === 11 && w === 2) span.events.push(readEvent(r.sub()));
    else if (f === 15 && w === 2) {
      const s = r.sub();
      for (const [sf, sw] of s.fields()) {
        if (sf === 2 && sw === 2) span.status.message = s.string();
        else if (sf === 3 && sw === 0) span.status.code = s.uint();
        else s.skip(sw);
      }
    } else r.skip(w);
  }
  return span;
}

function readScopeSpans(r: Reader): OtlpScopeSpans {
  const out: OtlpScopeSpans = { scope: { name: '', version: '' }, spans: [] };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) {
      const s = r.sub();
      for (const [sf, sw] of s.fields()) {
        if (sf === 1 && sw === 2) out.scope.name = s.string();
        else if (sf === 2 && sw === 2) out.scope.version = s.string();
        else s.skip(sw);
      }
    } else if (f === 2 && w === 2) out.spans.push(readSpan(r.sub()));
    else r.skip(w);
  }
  return out;
}

export function decodeProtobuf(body: Uint8Array): OtlpResourceSpans[] {
  const r = new Reader(body);
  const out: OtlpResourceSpans[] = [];
  try {
    for (const [f, w] of r.fields()) {
      if (f !== 1 || w !== 2) {
        r.skip(w);
        continue;
      }
      const rs = r.sub();
      const resourceSpans: OtlpResourceSpans = { resource: {}, scopeSpans: [] };
      for (const [rf, rw] of rs.fields()) {
        if (rf === 1 && rw === 2) resourceSpans.resource = readKeyValues(rs.sub(), 1);
        else if (rf === 2 && rw === 2) resourceSpans.scopeSpans.push(readScopeSpans(rs.sub()));
        else rs.skip(rw);
      }
      out.push(resourceSpans);
    }
  } catch (error) {
    if (error instanceof OtlpDecodeError) throw error;
    throw new OtlpDecodeError((error as Error).message);
  }
  return out;
}

/** ExportTraceServiceResponse, with partial_success when spans were rejected. */
export function encodeProtobufResponse(
  rejectedSpans: number,
  errorMessage: string,
): Uint8Array<ArrayBuffer> {
  if (rejectedSpans === 0) return new Uint8Array(0);
  const message = new TextEncoder().encode(errorMessage);
  const inner = [
    0x08,
    ...varintBytes(BigInt(rejectedSpans)),
    0x12,
    ...varintBytes(BigInt(message.length)),
    ...message,
  ];
  return new Uint8Array([0x0a, ...varintBytes(BigInt(inner.length)), ...inner]);
}

function varintBytes(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

// ─── JSON ────────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** OTLP/JSON uses lowerCamelCase; protobuf JSON parsers also accept the original snake_case. */
function field(obj: Json, camel: string): unknown {
  if (camel in obj) return obj[camel];
  return obj[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Ids are hex in OTLP/JSON; some older exporters sent base64. */
function jsonId(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || value === '') return '';
  if (/^[0-9a-fA-F]+$/.test(value) && value.length === bytes * 2) return value.toLowerCase();
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes ? decoded.toString('hex') : '';
}

function jsonNanos(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return BigInt(Math.trunc(value));
  return 0n;
}

const SPAN_KINDS: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};
const STATUS_CODES: Record<string, number> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function jsonEnum(value: unknown, names: Record<string, number>): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return names[value] ?? 0;
  return 0;
}

function jsonAnyValue(value: unknown, depth: number): OtlpValue {
  if (!isObject(value)) return null;
  if (depth > MAX_VALUE_DEPTH) return '[nested too deeply]';
  const s = field(value, 'stringValue');
  if (typeof s === 'string') return s;
  const b = field(value, 'boolValue');
  if (typeof b === 'boolean') return b;
  const i = field(value, 'intValue');
  if (typeof i === 'number') return i;
  if (typeof i === 'string' && /^-?\d+$/.test(i)) return int64(BigInt(i));
  const d = field(value, 'doubleValue');
  if (typeof d === 'number') return d;
  if (typeof d === 'string' && d !== '' && !Number.isNaN(Number(d))) return Number(d);
  const a = field(value, 'arrayValue');
  if (isObject(a)) return list(a.values).map((v) => jsonAnyValue(v, depth + 1));
  const kv = field(value, 'kvlistValue');
  if (isObject(kv)) return jsonKeyValues(kv.values, depth + 1);
  const bytes = field(value, 'bytesValue');
  if (typeof bytes === 'string') return bytes;
  return null;
}

function jsonKeyValues(value: unknown, depth = 0): OtlpAttributes {
  const out: OtlpAttributes = {};
  for (const kv of list(value)) {
    if (!isObject(kv) || typeof kv.key !== 'string' || kv.key === '') continue;
    out[kv.key] = jsonAnyValue(kv.value, depth);
  }
  return out;
}

export function decodeJson(body: unknown): OtlpResourceSpans[] {
  if (!isObject(body)) throw new OtlpDecodeError('the body is not a JSON object');
  return list(field(body, 'resourceSpans'))
    .filter(isObject)
    .map((rs) => ({
      resource: jsonKeyValues(isObject(rs.resource) ? rs.resource.attributes : []),
      scopeSpans: list(field(rs, 'scopeSpans'))
        .filter(isObject)
        .map((ss) => {
          const scope = isObject(ss.scope) ? ss.scope : {};
          return {
            scope: {
              name: typeof scope.name === 'string' ? scope.name : '',
              version: typeof scope.version === 'string' ? scope.version : '',
            },
            spans: list(ss.spans)
              .filter(isObject)
              .map((s): OtlpSpan => {
                const status = isObject(s.status) ? s.status : {};
                return {
                  traceId: jsonId(field(s, 'traceId'), 16),
                  spanId: jsonId(field(s, 'spanId'), 8),
                  parentSpanId: jsonId(field(s, 'parentSpanId'), 8) || null,
                  name: typeof s.name === 'string' ? s.name : '',
                  kind: jsonEnum(s.kind, SPAN_KINDS),
                  startTimeUnixNano: jsonNanos(field(s, 'startTimeUnixNano')),
                  endTimeUnixNano: jsonNanos(field(s, 'endTimeUnixNano')),
                  attributes: jsonKeyValues(s.attributes),
                  events: list(s.events)
                    .filter(isObject)
                    .map((e) => ({
                      timeUnixNano: jsonNanos(field(e, 'timeUnixNano')),
                      name: typeof e.name === 'string' ? e.name : '',
                      attributes: jsonKeyValues(e.attributes),
                    })),
                  status: {
                    code: jsonEnum(status.code, STATUS_CODES),
                    message: typeof status.message === 'string' ? status.message : '',
                  },
                };
              }),
          };
        }),
    }));
}
