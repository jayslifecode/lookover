import type { RunStatus } from '../node/api';
import type { ReportError, ReportState } from './data/reduce';
import { defaultRoute, navigate, type Route, type RouteView, useRoute, viewRoute } from './data/route';
import { confirmedFindings, firstCapturedScreen } from './data/selectors';
import { useReport } from './data/store';
import { LensFilter } from './glass/glass';
import { cn } from './lib/utils';
import { ScreensView } from './screens/screens-view';
import type { LiveStatus } from './shell/live-indicator';
import { SegmentedControl, type SegmentedItem } from './shell/segmented-control';
import { TopBar } from './shell/top-bar';

/*
 * The report's shell: the top bar with the view switcher over the page, and the main area the current
 * route's view fills. The Screens view is in; the other views come with the next tasks, and until then
 * the main area names the route it shows.
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

function routeSummary(report: ReportState, route: Route): string {
  if (report.manifest === null) return 'Loading the run…';
  if (route.view === 'findings') return `${confirmedFindings(report).length} confirmed findings.`;
  if (route.view === 'screens') return 'The screens the run captured.';
  return report.manifest.previousRunId === null
    ? 'This is the first run: there is nothing to compare it with.'
    : `Compared with the run ${report.manifest.previousRunId}.`;
}

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
  return (
    <section
      id={VIEW_PANEL_ID}
      role="tabpanel"
      aria-labelledby="view-title"
      className="rounded-lg border border-line bg-bg-1 p-6"
    >
      <h1 id="view-title" className="font-bold text-2xl tracking-tight">
        {VIEW_TITLE[route.view]}
      </h1>
      <p className="mt-1 max-w-[58ch] text-ink-2">{routeSummary(report, route)}</p>
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
    </div>
  );
}
