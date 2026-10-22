import { useEffect, useState } from 'react';
import { API_PATHS, type ApiErrorBody, type RunManifest, type RunStatus } from '../node/api';
import { LensFilter } from './glass/glass';
import type { LiveStatus } from './shell/live-indicator';
import { TopBar } from './shell/top-bar';

/*
 * The report's shell: the top bar over the page, and the main area the views fill. For now it loads only
 * what the shell shows, the run's manifest.
 */

type ManifestState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly manifest: RunManifest }
  | { readonly state: 'failed'; readonly message: string };

/**
 * The manifest says only whether the run is still going; which phase it is in comes from the event
 * stream, so a running run shows its first phase.
 */
const LIVE_STATUS: Readonly<Record<RunStatus, LiveStatus>> = {
  running: 'mapping',
  finished: 'done',
  failed: 'failed',
};

async function fetchManifest(signal: AbortSignal): Promise<RunManifest> {
  const response = await fetch(API_PATHS.run, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(body?.error ?? `The report server answered ${response.status}`);
  }
  return (await response.json()) as RunManifest;
}

function useRunManifest(): ManifestState {
  const [state, setState] = useState<ManifestState>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    fetchManifest(controller.signal).then(
      (manifest) => setState({ state: 'ready', manifest }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ state: 'failed', message });
      },
    );
    return () => controller.abort();
  }, []);
  return state;
}

function MainArea({ run }: { run: ManifestState }) {
  if (run.state === 'failed') {
    return (
      <div role="alert" className="rounded-lg border border-line bg-bg-1 p-6">
        <h1 className="font-bold text-lg">The run could not be loaded</h1>
        <p className="mt-1 text-ink-2">{run.message}</p>
      </div>
    );
  }
  return (
    <section aria-labelledby="report-title" className="rounded-lg border border-line bg-bg-1 p-6">
      <h1 id="report-title" className="font-bold text-2xl tracking-tight">
        Run report
      </h1>
      <p className="mt-1 max-w-[58ch] text-ink-2">
        {run.state === 'loading'
          ? 'Loading the run…'
          : 'The screens this run captured, the findings it confirmed and what changed since the last run will be shown here.'}
      </p>
    </section>
  );
}

export function App() {
  const run = useRunManifest();
  const manifest = run.state === 'ready' ? run.manifest : null;
  return (
    <div className="px-4 pt-3.5 pb-30 sm:px-6">
      <LensFilter />
      <TopBar
        runName={manifest?.runId ?? 'Lookover report'}
        baseUrl={manifest?.baseUrl ?? null}
        status={manifest === null ? null : LIVE_STATUS[manifest.status]}
      />
      <main className="mx-auto mt-6 max-w-[1120px]">
        <MainArea run={run} />
      </main>
    </div>
  );
}
