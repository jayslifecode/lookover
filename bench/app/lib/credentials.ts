import { createHash, timingSafeEqual } from 'node:crypto';

/** Documented demo defaults (bench/README.md); override with `BENCH_USER` and `BENCH_PASSWORD`. */
const DEFAULT_USER = 'demo@lookover.dev';
const DEFAULT_PASSWORD = 'demo-password';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares digests so the comparison takes the same time whatever the input's length. */
function safeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(digest(actual), digest(expected));
}

export function isValidLogin(email: string, password: string): boolean {
  const expectedUser = process.env.BENCH_USER || DEFAULT_USER;
  const expectedPassword = process.env.BENCH_PASSWORD || DEFAULT_PASSWORD;
  const isUserValid = safeEqual(email, expectedUser);
  const isPasswordValid = safeEqual(password, expectedPassword);
  return isUserValid && isPasswordValid;
}
