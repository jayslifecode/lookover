import { describe, expect, test } from 'vitest';
import { redact, redactDeep } from '../src/util/redact.js';

const STRIPE_LIVE = 'sk_live_1234567890abcd';
const SUPABASE_PAT = ['sbp', '0123456789abcdef0123456789abcdef01234567'].join('_');

describe('redact', () => {
  test.each([
    ['email', 'contact jay@example.com now', 'contact [email] now'],
    ['multiple emails', 'a@b.co and c.d+tag@e-f.io', '[email] and [email]'],
    ['email followed by a full stop', 'write to jay@example.com.', 'write to [email].'],
    ['email with a one-letter top-level domain', 'x@y.z', '[email]'],
    ['jwt', 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnLW5hdHVyZQ end', 'session [jwt] end'],
    ['bearer token', 'Authorization: Bearer abc.def', 'Authorization: Bearer [token]'],
    ['aws access key', 'key AKIAIOSFODNN7EXAMPLE end', 'key [aws-key] end'],
    ['stripe live secret key', `use ${STRIPE_LIVE} here`, 'use [api-key] here'],
    ['stripe test publishable key', 'use pk_test_ABCDEFGH12345678 here', 'use [api-key] here'],
    ['stripe restricted key', 'use rk_live_ABCDEFGH12345678 here', 'use [api-key] here'],
    ['supabase publishable key', 'use sb_publishable_AbC-123_xyz789 here', 'use [api-key] here'],
    ['supabase secret key', 'use sb_secret_AbC-123_xyz789 here', 'use [api-key] here'],
    ['supabase personal access token', `use ${SUPABASE_PAT} here`, 'use [api-key] here'],
    ['api key in a quoted assignment', `apiKey: "${STRIPE_LIVE}"`, 'apiKey: "[redacted]"'],
    ['password with equals', 'password=hunter2', 'password=[redacted]'],
    ['token in JSON', '{"token":"abc123"}', '{"token":"[redacted]"}'],
    ['single-quoted upper-case key', "API_KEY = 'xyz'", "API_KEY = '[redacted]'"],
    ['secret suffix keeps the key name', 'client_secret: s3cr3t', 'client_secret: [redacted]'],
    ['hyphenated header name', 'X-Api-Key: abc123', 'X-Api-Key: [redacted]'],
    ['value stops at a comma', 'token: abc, next', 'token: [redacted], next'],
  ])('redacts %s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test.each([
    ['plain prose', 'nothing sensitive here'],
    ['the word token without a separator', 'token count is 5'],
    ['a key-like word that continues', 'secretary: Jane'],
    ['an already redacted value', 'password=[redacted]'],
    ['the empty string', ''],
  ])('leaves %s unchanged', (_name, input) => {
    expect(redact(input)).toBe(input);
  });

  test('is idempotent', () => {
    const input = `mail jay@example.com, Bearer abc.def, apiKey: "${STRIPE_LIVE}"`;
    const once = redact(input);
    expect(redact(once)).toBe(once);
  });
});

describe('redactDeep', () => {
  test('returns a new structure with every string redacted and leaves the input untouched', () => {
    const input = { a: ['x@y.z'], b: { c: 'ok' } };

    const output = redactDeep(input);

    expect(output).toEqual({ a: ['[email]'], b: { c: 'ok' } });
    expect(output).not.toBe(input);
    expect(output.a).not.toBe(input.a);
    expect(output.b).not.toBe(input.b);
    expect(input).toEqual({ a: ['x@y.z'], b: { c: 'ok' } });
  });

  test('preserves null, numbers, booleans and undefined', () => {
    const input = { n: null, num: 3, flag: false, missing: undefined, list: [1, true, null] };

    const output = redactDeep(input);

    expect(output).toEqual(input);
    expect('missing' in output).toBe(true);
  });

  test('redacts strings only, not object keys', () => {
    const output = redactDeep({ 'jay@example.com': 'jay@example.com' });

    expect(output).toEqual({ 'jay@example.com': '[email]' });
  });

  test('redacts a bare string', () => {
    expect(redactDeep('mail jay@example.com')).toBe('mail [email]');
  });

  test('leaves non-plain objects such as Date and Buffer untouched', () => {
    const date = new Date('2026-10-20T00:00:00Z');
    const buffer = Buffer.from('jay@example.com');

    const output = redactDeep({ date, buffer });

    expect(output.date).toBe(date);
    expect(output.buffer).toBe(buffer);
  });

  test('does not mutate nested arrays of objects', () => {
    const input = [{ token: 'abc', tags: ['a@b.co'] }];
    const snapshot = structuredClone(input);

    const output = redactDeep(input);

    expect(output).toEqual([{ token: 'abc', tags: ['[email]'] }]);
    expect(input).toEqual(snapshot);
  });
});
