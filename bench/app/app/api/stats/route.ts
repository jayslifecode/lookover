import { NextResponse } from 'next/server';

const SERVER_ERROR = 500;

/** The dashboard asks for its live stats here, and this endpoint always fails (seeded issue observers-004). */
export function GET(): NextResponse {
  return NextResponse.json({ error: 'stats unavailable' }, { status: SERVER_ERROR });
}
