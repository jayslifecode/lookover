import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from './lib/session';

const LOGIN_PATH = '/login';
const FOUND = 302;

/** Every page but the login page needs the session cookie; without it the request goes to the login page. */
export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === LOGIN_PATH || request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL(LOGIN_PATH, request.url), FOUND);
}

export const config = {
  // Next's own assets and dev endpoints (HMR, overlays) and the app icon stay reachable signed out.
  matcher: ['/((?!_next/|__nextjs|favicon.ico|icon.svg).*)'],
};
