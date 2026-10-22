import type { Screen } from '@jayslifecode/lookover-core';
import { useMemo, useRef } from 'react';
import type { ReportState } from '@/data/reduce';
import { findingsOnScreen, firstCapturedScreen, scorecard } from '@/data/selectors';
import { FindingPanel } from '@/findings/finding-panel';
import { PanelGhost } from '@/findings/panel-ghost';
import { usePanelTransform } from '@/findings/use-panel-transform';
import { AnnotatedScreenshot, Notice } from './annotated-screenshot';
import { Scorecard } from './scorecard';
import { ScreenList } from './screen-list';
import { StateGallery } from './state-gallery';

/*
 * The Screens view (`#/screens/<id>?f=<findingId>`): the screen list, the screen's pinned screenshot with
 * the findings it cannot pin listed under it, the finding panel, and the screen's scorecard and state
 * gallery. At 1440 px that is a 280 px sidebar, the screenshot column and the 380 px panel, which sticks
 * under the top bar beside everything else; from `lg` the panel sits under the screenshot; at phone width
 * everything stacks in that order, the list a strip that scrolls sideways on top. The whole view is the
 * stage of the pin → panel container transform: a choice of another pin grows the panel out of it.
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
const SIDEBAR =
  'min-w-0 lg:sticky lg:top-[84px] lg:row-span-3 lg:max-h-[calc(100vh-100px)] lg:overflow-y-auto xl:row-span-2';
const MAIN = 'grid min-w-0 gap-4 lg:col-start-2';
const PANEL = 'lg:col-start-2 xl:col-start-3 xl:row-span-2 xl:row-start-1';

/** The screen the route names (`undefined`: the run has no such screen), else the first captured one. */
function shownScreen(report: ReportState, screenId: string | null): Screen | null | undefined {
  if (screenId === null) return firstCapturedScreen(report);
  return report.screens.find((screen) => screen.id === screenId);
}

function ScreenShot({
  report,
  screen,
  findingId,
}: {
  readonly report: ReportState;
  readonly screen: Screen;
  readonly findingId: string | null;
}) {
  const findings = useMemo(() => findingsOnScreen(report, screen.id), [report, screen.id]);
  const { width, height } = screen.viewport;
  return (
    <div className={MAIN}>
      <header className="min-w-0">
        <h1 className="break-words font-bold text-2xl tracking-tight">{screen.title}</h1>
        <p className="mt-0.5 break-all font-mono text-[12.5px] text-ink-2">
          {`${screen.route} · captured at ${width}×${height}`}
        </p>
      </header>
      <AnnotatedScreenshot screen={screen} findings={findings} selectedId={findingId} />
    </div>
  );
}

function ScreenNumbers({ report, screen }: { readonly report: ReportState; readonly screen: Screen }) {
  const card = useMemo(() => scorecard(report, screen.id), [report, screen.id]);
  const gallery = report.inspections.get(screen.id)?.gallery ?? null;
  return (
    <div className={MAIN}>
      <Scorecard card={card} />
      <StateGallery gallery={gallery} />
    </div>
  );
}

export function ScreensView({ report, screenId, findingId }: ScreensViewProps) {
  const screen = shownScreen(report, screenId);
  const stage = useRef<HTMLDivElement>(null);
  const { shownId, ghost, contentRef, ghostRef } = usePanelTransform(findingId, stage);
  return (
    <div ref={stage} className="relative">
      <div className={LAYOUT}>
        <div className={SIDEBAR}>
          <ScreenList report={report} currentId={screen?.id ?? null} />
        </div>
        {screen === undefined ? (
          <div className={MAIN}>
            <Notice>{`This run has no screen ${screenId}.`}</Notice>
          </div>
        ) : screen === null ? (
          <div className={MAIN}>
            <Notice>No screen has been captured yet.</Notice>
          </div>
        ) : (
          <ScreenShot report={report} screen={screen} findingId={findingId} />
        )}
        <FindingPanel report={report} findingId={shownId} contentRef={contentRef} className={PANEL} />
        {screen == null ? null : <ScreenNumbers report={report} screen={screen} />}
      </div>
      {ghost === null ? null : (
        <PanelGhost key={ghost.findingId} ref={ghostRef} report={report} findingId={ghost.findingId} />
      )}
    </div>
  );
}
