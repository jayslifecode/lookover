import type { RunStatus } from '../node/api';
import { Toaster } from './components/ui/sonner';
import type { ReportError, ReportState } from './data/reduce';
import { defaultRoute, navigate, type Route, type RouteView, useRoute, viewRoute } from './data/route';
import { firstCapturedScreen } from './data/selectors';
import { useReport } from './data/store';
import { DriftView } from './drift/drift-view';
import { FindingsView } from './findings/findings-view';
import { LensFilter } from './glass/glass';
import { cn } from './lib/utils';
import { ScreensView } from './screens/screens-view';
import { CostReadout } from './shell/cost-readout';
import type { LiveStatus } from './shell/live-indicator';
import { SegmentedControl, type SegmentedItem } from './shell/segmented-control';
import { TopBar } from './shell/top-bar';

/*
 * The report's shell: the top bar with the view switcher and the cost readout over the page, and the
 * main area the current route's view fills (Screens, Findings or Drift).
 */

/**
 * The run's state says only whether it is still going; which phase it is in comes with the live states,
 * so a running run shows its first phase.
 */
const LIVE_STATUS: Readonly<Record<RunStatus, LiveStatus>> = {
  running: 'mapping',
  finished: 'done',
  failed: 'failed',
};

const VIEW_TABS: readonly SegmentedItem<RouteView>[] = [
  { value: 'screens', label: 'Screens' },
  { value: 'findings', label: 'Findings' },
  { value: 'drift', label: 'Drift' },
];

const VIEW_TITLE: Readonly<Record<RouteView, string>> = {
  screens: 'Screens',
  findings: 'Findings',
  drift: 'Drift',
};

const VIEW_PANEL_ID = 'report-view';

function MainArea({
  report,
  route,
  error,
}: {
  report: ReportState;
  route: Route;
  error: ReportError | null;
}) {
  if (error !== null) {
    return (
      <div role="alert" className="rounded-lg border border-line bg-bg-1 p-6">
        <h1 className="font-bold text-lg">The run could not be loaded</h1>
        <p className="mt-1 text-ink-2">{error.message}</p>
      </div>
    );
  }
  if (route.view === 'screens' && report.manifest !== null) {
    return (
      <section id={VIEW_PANEL_ID} role="tabpanel" aria-label={VIEW_TITLE.screens}>
        <ScreensView report={report} screenId={route.screenId} findingId={route.findingId} />
      </section>
    );
  }
  if (route.view === 'findings' && report.manifest !== null) {
    return (
      <section id={VIEW_PANEL_ID} role="tabpanel" aria-label={VIEW_TITLE.findings}>
        <FindingsView report={report} findingId={route.findingId} />
      </section>
    );
  }
  if (route.view === 'drift' && report.manifest !== null) {
    return (
      <section id={VIEW_PANEL_ID} role="tabpanel" aria-label={VIEW_TITLE.drift}>
        <DriftView report={report} />
      </section>
    );
  }
  return (
    <section
      id={VIEW_PANEL_ID}
      role="tabpanel"
      aria-label={VIEW_TITLE[route.view]}
      className="rounded-lg border border-line bg-bg-1 p-6"
    >
      <p className="m-0 text-ink-2">Loading the run…</p>
    </section>
  );
}

export function App() {
  const report = useReport();
  const firstScreenId = firstCapturedScreen(report)?.id ?? null;
  const route = useRoute() ?? defaultRoute(firstScreenId);
  const { manifest } = report;
  const manifestError = report.errors.find((error) => error.source === 'manifest') ?? null;
  return (
    <div className="px-4 pt-3.5 pb-30 sm:px-6">
      <LensFilter />
      <TopBar
        runName={manifest?.runId ?? 'Lookover report'}
        baseUrl={manifest?.baseUrl ?? null}
        status={manifest === null ? null : LIVE_STATUS[report.run.status]}
        cost={
          manifest === null ? undefined : (
            <CostReadout totals={report.totals} isRunning={report.run.status === 'running'} />
          )
        }
        nav={
          <SegmentedControl
            items={VIEW_TABS}
            value={route.view}
            label="Report views"
            controls={VIEW_PANEL_ID}
            onChange={(view) => navigate(viewRoute(view, firstScreenId))}
          />
        }
      />
      <main className={cn('mx-auto mt-6', route.view === 'screens' ? 'max-w-[1392px]' : 'max-w-[1120px]')}>
        <MainArea report={report} route={route} error={manifestError} />
      </main>
      {/* Bottom centre: clear of the finding panel on the right. */}
      <Toaster position="bottom-center" />
    </div>
  );
}
