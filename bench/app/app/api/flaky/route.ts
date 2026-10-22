import { NextResponse } from 'next/server';

const SERVER_ERROR = 500;
/** The requests the answers repeat over, and how many at the start of each fail. */
const CYCLE_LENGTH = 6;
const FAILURES_PER_CYCLE = 2;

/** Requests answered since the server started (module scope: it lives as long as the server does). */
let answered = 0;

/**
 * The reports page asks for the report service's status here, and this endpoint fails the first two
 * requests of every six with a `500` (control-004, the timing control): a failure that comes and goes,
 * which Lookover must reject as timing rather than report. See bench/README.md for why the crawl's own
 * load of `/reports` fails and the reproduction attempts' loads do not.
 */
export function GET(): NextResponse {
  const position = answered % CYCLE_LENGTH;
  answered += 1;
  if (position < FAILURES_PER_CYCLE) {
    return NextResponse.json({ error: 'report service unavailable' }, { status: SERVER_ERROR });
  }
  return NextResponse.json({ status: 'ok' });
}
