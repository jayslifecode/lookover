'use client';

import { useEffect, useState } from 'react';

const STATS_URL = '/api/stats';

type StatsState = 'loading' | 'ready' | 'unavailable';

const MESSAGES: Readonly<Record<StatsState, string>> = {
  loading: 'Loading live stats…',
  ready: 'Live stats are up to date.',
  unavailable: 'Live stats are unavailable right now.',
};

async function loadStats(): Promise<StatsState> {
  try {
    const response = await fetch(STATS_URL);
    return response.ok ? 'ready' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Asks `/api/stats` for the live stats when the dashboard opens and says how that went. */
export function StatsStatus() {
  const [state, setState] = useState<StatsState>('loading');
  useEffect(() => {
    let isCurrent = true;
    loadStats().then((next) => {
      if (isCurrent) setState(next);
    });
    return () => {
      isCurrent = false;
    };
  }, []);
  return (
    <p role="status" className="text-sm text-slate-700">
      {MESSAGES[state]}
    </p>
  );
}
