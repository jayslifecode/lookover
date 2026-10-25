import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 16 random bytes: 128 bits, written as 32 hex digits. */
const TOKEN_BYTES = 16;

/** A new token for one report server: 32 hex digits from the system's secure random source. */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Whether `given` (from a request) is `expected`, compared in constant time. Strings of different
 * lengths never match; that the lengths differ is all a timing can tell, and every token has the same.
 */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
