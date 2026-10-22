import { Toaster } from './components/ui/sonner';
import type { ReportState } from './data/reduce';
import { defaultRoute, navigate, type Route, type RouteView, useRoute, viewRoute } from './data/route';
import { firstCapturedScreen, isReconnecting } from './data/selectors';
import { useReport } from './data/store';
import { DriftView } from './drift/drift-view';
import { FindingsView } from './findings/findings-view';
import { LensFilter } from './glass/glass';
import { cn } from './lib/utils';
import { ScreensView } from './screens/screens-view';
import { CostReadout } from './shell/cost-readout';
import { NoRunYet } from './shell/empty-states';
import { ErrorBoundary } from './shell/error-boundary';
import { liveStatusOf } from './shell/live-indicator';
import { RunFailedNotice } from './shell/run-failed-notice';
import { SegmentedControl, type SegmentedItem } from './shell/segmented-control';
import { TopBar } from './shell/top-bar';

/*
 * The report's shell: the top bar with the view switcher, the cost readout and where the run is, over
 * the page, and the main area the current route's view fills (Screens, Findings or Drift). A run that
 * failed says so at the top of the main area; with no run yet, the page says how to make one. Each view
 * is held by an error boundary, so one that cannot render leaves the rest of the page standing.
 */

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
const SOLID_BOX = 'rounded-lg border border-line bg-bg-1 p-6';

function View({ report, route }: { readonly report: ReportState; readonly route: Route }) {
  switch (route.view) {
    case 'screens':
      return <ScreensView report={report} screenId={route.screenId} findingId={route.findingId} />;
    case 'findings':
      return <FindingsView report={report} findingId={route.findingId} />;
    case 'drift':
      return <DriftView report={report} />;
  }
}

/** What the main area holds before the run is known: no run yet, a failure to load it, or a wait. */
function NoView({ report }: { readonly report: ReportState }) {
  const error = report.errors.find((known) => known.source === 'manifest');
  if (error?.isNotFound === true) return <NoRunYet />;
  if (error !== undefined) {
    return (
      <div role="alert" className={SOLID_BOX}>
        <h1 className="font-bold text-lg">The run could not be loaded</h1>
        <p className="mt-1 text-ink-2">{error.message}</p>
      </div>
    );
  }
  return <p className={cn(SOLID_BOX, 'm-0 text-ink-2')}>Loading the run…</p>;
}

function MainArea({ report, route }: { readonly report: ReportState; readonly route: Route }) {
  const { error } = report.run;
  return (
    <>
      {report.run.status === 'failed' && error !== null ? <RunFailedNotice error={error} /> : null}
      <section id={VIEW_PANEL_ID} role="tabpanel" aria-label={VIEW_TITLE[route.view]}>
        {report.manifest === null ? (
          <NoView report={report} />
        ) : (
          <ErrorBoundary label={`${VIEW_TITLE[route.view]} view`} resetKey={route.view}>
            <View report={report} route={route} />
          </ErrorBoundary>
        )}
      </section>
    </>
  );
}

export function App() {
  const report = useReport();
  const firstScreenId = firstCapturedScreen(report)?.id ?? null;
  const route = useRoute() ?? defaultRoute(firstScreenId);
  const { manifest } = report;
  return (
    <div className="px-4 pt-3.5 pb-30 sm:px-6">
      <LensFilter />
      <TopBar
        runName={manifest?.runId ?? 'Lookover report'}
        baseUrl={manifest?.baseUrl ?? null}
        status={manifest === null ? null : liveStatusOf(report)}
        isReconnecting={isReconnecting(report)}
        cost={
          manifest === null ? undefined : (
            <CostReadout totals={report.totals} isFinished={report.run.status === 'finished'} />
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
        <MainArea report={report} route={route} />
      </main>
      {/* Bottom centre: clear of the finding panel on the right. */}
      <Toaster position="bottom-center" />
    </div>
  );
}
