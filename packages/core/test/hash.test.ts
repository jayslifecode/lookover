import { describe, expect, test } from 'vitest';
import { sha256, shortId } from '../src/util/hash.js';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256', () => {
  test('returns the hex digest of a string', () => {
    expect(sha256('abc')).toBe(ABC_SHA256);
  });

  test('hashes a Buffer the same as the equivalent string', () => {
    expect(sha256(Buffer.from('abc'))).toBe(ABC_SHA256);
  });
});

describe('shortId', () => {
  test('defaults to the first 12 hex characters of the digest', () => {
    expect(shortId('abc')).toBe(ABC_SHA256.slice(0, 12));
  });

  test('honours a custom length', () => {
    expect(shortId(Buffer.from('abc'), 8)).toBe(ABC_SHA256.slice(0, 8));
  });
});
