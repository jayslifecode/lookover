import type { Screen } from '@jayslifecode/lookover-core';
import { useMemo } from 'react';
import type { ReportState } from '@/data/reduce';
import { findingsOnScreen, firstCapturedScreen, scorecard } from '@/data/selectors';
import { AnnotatedScreenshot, Notice, UnpinnedFindings } from './annotated-screenshot';
import { Scorecard } from './scorecard';
import { ScreenList } from './screen-list';
import { StateGallery } from './state-gallery';

/*
 * The Screens view (`#/screens/<id>?f=<findingId>`): the screen list, the screen's pinned screenshot with
 * its unpinned findings, its scorecard and its state gallery under it, and on the right the room the
 * finding panel takes. At 1440 px that is a 280 px sidebar, the screenshot column and a 380 px column
 * (from `xl`; below it the panel's room is not kept); at phone width everything stacks, the list a strip
 * that scrolls sideways on top.
 */

export interface ScreensViewProps {
  readonly report: ReportState;
  /** The route's screen; `null` for the first captured one. */
  readonly screenId: string | null;
  /** The route's selected finding. */
  readonly findingId: string | null;
}

const LAYOUT =
  'grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_380px]';
const SIDEBAR = 'min-w-0 lg:sticky lg:top-[84px] lg:max-h-[calc(100vh-100px)] lg:overflow-y-auto';

/** The screen the route names (`undefined`: the run has no such screen), else the first captured one. */
function shownScreen(report: ReportState, screenId: string | null): Screen | null | undefined {
  if (screenId === null) return firstCapturedScreen(report);
  return report.screens.find((screen) => screen.id === screenId);
}

function ScreenDetail({
  report,
  screen,
  findingId,
}: {
  readonly report: ReportState;
  readonly screen: Screen;
  readonly findingId: string | null;
}) {
  const findings = useMemo(() => findingsOnScreen(report, screen.id), [report, screen.id]);
  const card = useMemo(() => scorecard(report, screen.id), [report, screen.id]);
  const gallery = report.inspections.get(screen.id)?.gallery ?? null;
  const { width, height } = screen.viewport;
  return (
    <div className="grid min-w-0 gap-4">
      <header className="min-w-0">
        <h1 className="break-words font-bold text-2xl tracking-tight">{screen.title}</h1>
        <p className="mt-0.5 break-all font-mono text-[12.5px] text-ink-2">
          {`${screen.route} · captured at ${width}×${height}`}
        </p>
      </header>
      <AnnotatedScreenshot screen={screen} findings={findings} selectedId={findingId} />
      <UnpinnedFindings screen={screen} findings={findings} selectedId={findingId} />
      <Scorecard card={card} />
      <StateGallery gallery={gallery} />
    </div>
  );
}

export function ScreensView({ report, screenId, findingId }: ScreensViewProps) {
  const screen = shownScreen(report, screenId);
  return (
    <div className={LAYOUT}>
      <div className={SIDEBAR}>
        <ScreenList report={report} currentId={screen?.id ?? null} />
      </div>
      {screen === undefined ? (
        <Notice>{`This run has no screen ${screenId}.`}</Notice>
      ) : screen === null ? (
        <Notice>No screen has been captured yet.</Notice>
      ) : (
        <ScreenDetail report={report} screen={screen} findingId={findingId} />
      )}
      <aside
        aria-label="Finding"
        className="hidden rounded-lg border border-line bg-bg-1 p-4 text-[13px] text-ink-2 xl:sticky xl:top-[84px] xl:block"
      >
        Choose a pin on the screenshot, or a finding listed under it, to read it here.
      </aside>
    </div>
  );
}
