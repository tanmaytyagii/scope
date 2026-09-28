/**
 * Identifier generation.
 *
 * Trace and span IDs follow W3C Trace Context (32 and 16 lowercase hex characters) so they can
 * be exchanged with OpenTelemetry. Other entities use prefixed ULIDs, which sort by creation
 * time and are safe to show to people.
 */

const HEX = '0123456789abcdef';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += (HEX[byte >> 4] as string) + (HEX[byte & 15] as string);
  return out;
}

function nonZeroHex(byteCount: number): string {
  // An all-zero ID is invalid in W3C Trace Context; the chance is negligible but cheap to rule out.
  for (;;) {
    const hex = toHex(randomBytes(byteCount));
    if (!/^0+$/.test(hex)) return hex;
  }
}

export function newTraceId(): string {
  return nonZeroHex(16);
}

export function newSpanId(): string {
  return nonZeroHex(8);
}

export function isTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}

export function isSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
}

/** A 26-character ULID: 48-bit millisecond timestamp + 80 bits of randomness. */
export function ulid(time: number = Date.now()): string {
  let timePart = '';
  let t = Math.floor(time);
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const random = randomBytes(16);
  let randomPart = '';
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD[(random[i] as number) % 32];
  return timePart + randomPart;
}

export type IdPrefix = 'run' | 'ev' | 'prj' | 'wf' | 'wfv' | 'key' | 'req';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** Short, human-friendly form of a trace or span ID, as shown in the CLI and dashboard. */
export function shortId(id: string, length = 7): string {
  const underscore = id.indexOf('_');
  const body = underscore >= 0 ? id.slice(underscore + 1) : id;
  return body.slice(0, length).toLowerCase();
}
