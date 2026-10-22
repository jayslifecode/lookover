'use client';

import { useEffect, useRef, useState } from 'react';

const FLAKY_URL = '/api/flaky';

type FlakyState = 'loading' | 'ready' | 'unavailable';

const MESSAGES: Readonly<Record<FlakyState, string>> = {
  loading: 'Checking the report service…',
  ready: 'The report service is up.',
  unavailable: 'The report service is not answering right now.',
};

/**
 * Asks `/api/flaky` how the report service is, once per page load, and says how that went. A failed
 * answer is also logged as `flaky: <status>` (control-004: both the request and the console error come
 * and go, and Lookover must reject them as timing).
 */
export function FlakyStatus() {
  const [state, setState] = useState<FlakyState>('loading');
  // Strict Mode runs a mount effect twice in development; the ref keeps it to one request per load,
  // which the control's failure pattern counts on.
  const hasAsked = useRef(false);
  useEffect(() => {
    if (hasAsked.current) return;
    hasAsked.current = true;
    fetch(FLAKY_URL).then(
      (response) => {
        if (!response.ok) console.error(`flaky: ${response.status}`);
        setState(response.ok ? 'ready' : 'unavailable');
      },
      () => setState('unavailable'),
    );
  }, []);
  return (
    <p role="status" className="text-sm text-slate-700">
      {MESSAGES[state]}
    </p>
  );
}
