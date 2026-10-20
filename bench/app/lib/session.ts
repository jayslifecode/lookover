/** Its presence is the whole session: `proxy.ts` lets a request through when the cookie is set. */
export const SESSION_COOKIE = 'bench_session';

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
} as const;
