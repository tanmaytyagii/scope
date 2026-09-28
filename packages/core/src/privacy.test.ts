import { describe, expect, it } from 'vitest';
import { capture, createPrivacyPolicy, isTruncatedPayload, redactText } from './privacy.ts';

describe('redactText', () => {
  it.each([
    ['openai key', 'key: sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'openai_key'],
    ['anthropic key', 'use sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef', 'anthropic_key'],
    ['github token', 'token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', 'github_token'],
    ['aws key', 'AKIAIOSFODNN7EXAMPLE is the id', 'aws_access_key'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt',
    ],
    ['scope key', 'Authorization uses scope_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'scope_api_key'],
  ])('redacts %s', (_label, input, rule) => {
    const result = redactText(input);
    expect(result.text).toContain(`[redacted:${rule}]`);
    expect(result.redactions).toBeGreaterThan(0);
  });

  it('keeps the Bearer prefix', () => {
    const result = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.text).toBe('Authorization: Bearer [redacted:bearer_token]');
  });

  it('redacts private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----';
    expect(redactText(`before\n${pem}\nafter`).text).toBe('before\n[redacted:private_key]\nafter');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Refunds are processed within 5 business days. Order #12345 shipped.';
    expect(redactText(text)).toEqual({ text, redactions: 0 });
  });

  it('applies optional PII rules only when enabled', () => {
    const text = 'Contact jane@example.com, card 4111 1111 1111 1111.';
    expect(redactText(text).redactions).toBe(0);
    const policy = createPrivacyPolicy({ redact: ['email', 'credit_card'] });
    const result = redactText(text, policy);
    expect(result.text).toBe('Contact [redacted:email], card [redacted:credit_card].');
  });

  it('uses the Luhn check to avoid redacting arbitrary digit runs', () => {
    const policy = createPrivacyPolicy({ redact: ['credit_card'] });
    expect(redactText('order 1234 5678 9012 3456', policy).redactions).toBe(0);
  });

  it('supports custom patterns', () => {
    const policy = createPrivacyPolicy({ patterns: [{ name: 'ticket', pattern: 'TICKET-\\d+' }] });
    expect(redactText('see TICKET-991', policy).text).toBe('see [redacted:ticket]');
  });

  it('rejects unknown rule names', () => {
    expect(() => createPrivacyPolicy({ redact: ['emails'] })).toThrow(
      /Unknown redaction rule "emails"/,
    );
  });
});

describe('capture', () => {
  it('masks values under sensitive keys, including nested ones', () => {
    const result = capture({
      user: 'ana',
      password: 'hunter2',
      headers: { 'X-Api-Key': 'abc', accept: 'json' },
    });
    expect(result.value).toEqual({
      user: 'ana',
      password: '[redacted:sensitive_field]',
      headers: { 'X-Api-Key': '[redacted:sensitive_field]', accept: 'json' },
    });
    expect(result.redactions).toBe(2);
  });

  it('does not treat token-count fields as secrets', () => {
    expect(capture({ max_tokens: 400, input_tokens: 12 }).value).toEqual({
      max_tokens: 400,
      input_tokens: 12,
    });
  });

  it('returns null content when capture is disabled', () => {
    const policy = createPrivacyPolicy({ captureContent: false });
    expect(capture({ prompt: 'secret stuff' }, policy)).toEqual({
      value: null,
      redactions: 0,
      truncated: false,
      bytes: 0,
    });
  });

  it('truncates long strings and marks them', () => {
    const policy = createPrivacyPolicy({ maxPayloadBytes: 1024 });
    const result = capture('x'.repeat(5000), policy);
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe('string');
    expect(result.value as string).toMatch(/truncated: 5,000 bytes total/);
    expect((result.value as string).length).toBeLessThan(1100);
  });

  it('replaces oversized structures with a bounded preview', () => {
    const policy = createPrivacyPolicy({ maxPayloadBytes: 512 });
    const result = capture(
      Array.from({ length: 200 }, (_, i) => ({ i, text: 'hello world' })),
      policy,
    );
    expect(result.truncated).toBe(true);
    expect(isTruncatedPayload(result.value)).toBe(true);
    const value = result.value as { originalBytes: number; preview: string };
    expect(value.originalBytes).toBe(result.bytes);
    expect(value.preview.length).toBeLessThanOrEqual(512);
  });

  it('serializes non-JSON values safely', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    const result = capture({
      big: 10n,
      when: new Date(0),
      cyclic,
      fn: () => 1,
      err: new Error('boom'),
    });
    expect(result.value).toEqual({
      big: '10',
      when: '1970-01-01T00:00:00.000Z',
      cyclic: { name: 'a', self: '[circular]' },
      err: { name: 'Error', message: 'boom' },
    });
  });
});
