import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

const FOUND = 302;

/** Clears the session cookie and goes to the login page. */
export function GET(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url), FOUND);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
