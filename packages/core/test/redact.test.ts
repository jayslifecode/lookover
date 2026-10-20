import { describe, expect, test } from 'vitest';
import { redact, redactDeep } from '../src/util/redact.js';

const STRIPE_LIVE = 'sk_live_1234567890abcd';
const SUPABASE_PAT = ['sbp', '0123456789abcdef0123456789abcdef01234567'].join('_');
const LONG_RUN_LENGTH = 50_000;
/** Linear time takes a few milliseconds; quadratic takes seconds. Loose enough for a cold CI runner. */
const LONG_RUN_MAX_MS = 1_000;

describe('redact', () => {
  test.each([
    ['email', 'contact jay@example.com now', 'contact [email] now'],
    ['multiple emails', 'a@b.co and c.d+tag@e-f.io', '[email] and [email]'],
    ['email followed by a full stop', 'write to jay@example.com.', 'write to [email].'],
    ['email with a one-letter top-level domain', 'x@y.z', '[email]'],
    ['jwt', 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnLW5hdHVyZQ end', 'session [jwt] end'],
    ['bearer token', 'Authorization: Bearer abc.def', 'Authorization: Bearer [token]'],
    ['lowercase bearer token', 'authorization: bearer abc123opaque', 'authorization: Bearer [token]'],
    ['upper-case bearer token', 'AUTHORIZATION: BEARER abc123opaque', 'AUTHORIZATION: Bearer [token]'],
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
    ['double-quoted multi-word value', 'password: "two words here"', 'password: "[redacted]"'],
    ['single-quoted multi-word value', "password: 'two words here'", "password: '[redacted]'"],
    ['quoted value with an escaped quote', '{"password":"ab\\"cd ef"}', '{"password":"[redacted]"}'],
    ['unterminated quoted value', 'password: "two words', 'password: "[redacted]'],
    ['unquoted JSON number keeps the closing brace', '{"token":12345}', '{"token":[redacted]}'],
    [
      'unquoted JSON value keeps the next member',
      '{"token":12345,"next":1}',
      '{"token":[redacted],"next":1}',
    ],
    [
      'query string keeps the following parameter',
      'GET /cb?a=1&token=abc&next=/home',
      'GET /cb?a=1&token=[redacted]&next=/home',
    ],
    [
      'query string with an access_token',
      '/cb?access_token=abc123&state=1',
      '/cb?access_token=[redacted]&state=1',
    ],
    ['value in call parentheses keeps the closing one', 'login(password=abc)', 'login(password=[redacted])'],
    ['placeholder left by an earlier rule', 'token=jay@example.com', 'token=[redacted]'],
  ])('redacts %s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test.each([
    ['plain prose', 'nothing sensitive here'],
    ['the word token without a separator', 'token count is 5'],
    ['a key-like word that continues', 'secretary: Jane'],
    ['an already redacted value', 'password=[redacted]'],
    ['the empty string', ''],
    ['prose that mentions a bearer', 'the bearer of news'],
    ['a short word after a lowercase bearer', 'bearer of bad news'],
    ['a design token list', 'tokens: color-primary'],
  ])('leaves %s unchanged', (_name, input) => {
    expect(redact(input)).toBe(input);
  });

  test.each([
    ['mixed secrets', `mail jay@example.com, Bearer abc.def, apiKey: "${STRIPE_LIVE}"`],
    ['lowercase bearer', 'authorization: bearer abc123opaque'],
    ['quoted multi-word value', 'password: "two words here"'],
    ['single-quoted multi-word value', "password: 'two words here'"],
    ['unterminated quoted value', 'password: "two words'],
    ['JSON with an unquoted value', '{"token":12345,"next":1}'],
    ['query string', 'GET /cb?a=1&token=abc&next=/home'],
    ['placeholder under a key', 'token=jay@example.com'],
  ])('is idempotent for %s', (_name, input) => {
    const once = redact(input);

    expect(redact(once)).toBe(once);
  });

  test.each([
    ['a long run of local-part characters', 'a'.repeat(LONG_RUN_LENGTH)],
    ['a long local part followed by an at sign', `${'a'.repeat(LONG_RUN_LENGTH)}@`],
    ['a long run after an at sign', `a@${'b'.repeat(LONG_RUN_LENGTH)}`],
    ['repeated JWT prefixes', 'eyJ'.repeat(LONG_RUN_LENGTH / 2)],
    ['a long run of whitespace after a key', `token:${' '.repeat(LONG_RUN_LENGTH)}`],
    ['a long unterminated quote', `password: "${'a'.repeat(LONG_RUN_LENGTH)}`],
  ])('finishes quickly on %s', (_name, input) => {
    const start = performance.now();

    redact(input);

    expect(performance.now() - start).toBeLessThan(LONG_RUN_MAX_MS);
  });

  test('still redacts an email that follows a long run of other text', () => {
    expect(redact(`${'x '.repeat(1000)}jay@example.com`)).toBe(`${'x '.repeat(1000)}[email]`);
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

    expect(output).toEqual([{ token: '[redacted]', tags: ['[email]'] }]);
    expect(input).toEqual(snapshot);
  });

  describe('sensitive keys', () => {
    test('redacts string values under password, x-api-key, apiKey, refreshToken and client_secret', () => {
      const input = {
        password: 'hunter2',
        'x-api-key': 'abc123',
        apiKey: 'abc123',
        refreshToken: 'r-abc123',
        client_secret: 's3cr3t',
      };

      expect(redactDeep(input)).toEqual({
        password: '[redacted]',
        'x-api-key': '[redacted]',
        apiKey: '[redacted]',
        refreshToken: '[redacted]',
        client_secret: '[redacted]',
      });
    });

    test.each([
      'passwd',
      'pwd',
      'secret',
      'token',
      'apiSecret',
      'Authorization',
      'auth',
      'Cookie',
      'Set-Cookie',
      'sessionId',
      'private_key',
      'accessKey',
      'credential',
      'credentials',
      'X-Auth-Token',
      'DB_PASSWORD',
    ])('treats the key %s as sensitive', (key) => {
      expect(redactDeep({ [key]: 'value' })).toEqual({ [key]: '[redacted]' });
    });

    test('never alters the keys themselves', () => {
      expect(Object.keys(redactDeep({ 'X-Api-Key': 'abc', refresh_token: 'def' }))).toEqual([
        'X-Api-Key',
        'refresh_token',
      ]);
    });

    test('leaves design tokens (the plural key) unchanged', () => {
      const input = { tokens: [{ property: 'color', value: 'rgb(1, 2, 3)' }] };

      expect(redactDeep(input)).toEqual(input);
    });

    test('leaves keys that merely contain a sensitive word unchanged', () => {
      const input = { author: 'Jane', tokenCount: 'five', secretary: 'Sam', passwordHint: 'a pet' };

      expect(redactDeep(input)).toEqual(input);
    });

    test('leaves non-string values under a sensitive key alone', () => {
      const input = { token: 12345, password: null, secret: undefined, auth: false };

      expect(redactDeep(input)).toEqual(input);
    });

    test('walks a nested object under a sensitive key using its own keys', () => {
      const input = { credentials: { user: 'a@b.co', password: 'x', note: 'ok' } };

      expect(redactDeep(input)).toEqual({
        credentials: { user: '[email]', password: '[redacted]', note: 'ok' },
      });
    });

    test('redacts every string in an array under a sensitive key', () => {
      const input = { 'set-cookie': ['sid=1', 'theme=dark'], list: ['plain'] };

      expect(redactDeep(input)).toEqual({ 'set-cookie': ['[redacted]', '[redacted]'], list: ['plain'] });
    });

    test('still runs the text rules on strings under ordinary keys', () => {
      expect(redactDeep({ url: '/cb?token=abc&next=/home', note: 'Bearer abc.def' })).toEqual({
        url: '/cb?token=[redacted]&next=/home',
        note: 'Bearer [token]',
      });
    });

    test('does not mutate the input', () => {
      const input = { password: 'hunter2', nested: { 'x-api-key': 'abc', list: ['sid=1'] } };
      const snapshot = structuredClone(input);

      redactDeep(input);

      expect(input).toEqual(snapshot);
    });
  });
});
