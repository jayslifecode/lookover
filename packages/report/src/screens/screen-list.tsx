import type { Screen, Severity } from '@jayslifecode/lookover-core';
import { memo, useEffect, useRef } from 'react';
import type { ReportState } from '@/data/reduce';
import { formatRoute } from '@/data/route';
import { isInspecting, SEVERITY_ORDER, scorecard } from '@/data/selectors';
import { cn } from '@/lib/utils';
import { SEVERITY_DOT, SEVERITY_LABEL } from './severity';

/*
 * The captured screens, as a solid sidebar (glass is only for what floats over content): one link per
 * screen with its route, its title and its confirmed findings by severity, a screen whose navigation
 * failed marked as such, and the one shown marked `aria-current="page"`. The links are in the Tab order,
 * so the list is walked with the keyboard. Below `lg` it is a strip that scrolls sideways above the
 * screenshot.
 */

export interface ScreenListProps {
  readonly report: ReportState;
  /** The screen shown. */
  readonly currentId: string | null;
}

function SeverityCounts({ counts }: { readonly counts: Readonly<Record<Severity, number>> }) {
  const present = SEVERITY_ORDER.filter((severity) => counts[severity] > 0);
  if (present.length === 0) return <span className="text-ink-2">No findings</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {present.map((severity) => (
        <span key={severity} className="inline-flex items-center gap-1.5 text-ink-2">
          <span aria-hidden="true" className={cn('size-2 rounded-full', SEVERITY_DOT[severity])} />
          {`${counts[severity]} ${SEVERITY_LABEL[severity].toLowerCase()}`}
        </span>
      ))}
    </span>
  );
}

function ScreenLink({
  screen,
  counts,
  isCurrent,
  isBeingInspected,
}: {
  readonly screen: Screen;
  readonly counts: Readonly<Record<Severity, number>>;
  readonly isCurrent: boolean;
  readonly isBeingInspected: boolean;
}) {
  const isFailed = screen.status === 'navigation-failed';
  return (
    <a
      href={formatRoute({ view: 'screens', screenId: screen.id, findingId: null })}
      aria-current={isCurrent ? 'page' : undefined}
      className={cn(
        'block min-h-11 rounded-md border px-3 py-2 text-[12.5px]',
        isCurrent ? 'border-line-strong bg-bg-2' : 'border-transparent hover:bg-bg-2',
      )}
    >
      <span className="block truncate font-mono text-[12px] text-ink-2">{screen.route}</span>
      <span className="block truncate font-semibold text-[13.5px] text-ink">
        {isFailed ? (screen.error ?? screen.title) : screen.title}
      </span>
      <span className="mt-1 block">
        {isFailed ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
            <span aria-hidden="true" className="size-2 rounded-full bg-high" />
            Navigation failed
          </span>
        ) : isBeingInspected ? (
          <span className="text-ink-2">inspecting…</span>
        ) : (
          <SeverityCounts counts={counts} />
        )}
      </span>
    </a>
  );
}

/** Through `memo`: a choice of finding leaves the list as it is. */
export const ScreenList = memo(function ScreenList({ report, currentId }: ScreenListProps) {
  const list = useRef<HTMLUListElement>(null);
  // On the strip, the screen shown may be scrolled out of sight: bring it in whenever it changes.
  useEffect(() => {
    if (currentId === null) return;
    const current = list.current?.querySelector<HTMLElement>('[aria-current="page"]');
    // jsdom has no scrollIntoView.
    current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [currentId]);
  return (
    <nav aria-label="Screens" className="min-w-0 rounded-lg border border-line bg-bg-1 p-1">
      {/* The padding leaves room for the focus ring, which the scrolling list would otherwise clip. */}
      <ul ref={list} className="flex snap-x gap-1 overflow-x-auto p-1 lg:flex-col lg:overflow-x-visible">
        {report.screens.map((screen) => (
          <li key={screen.id} className="w-56 shrink-0 snap-start lg:w-auto">
            <ScreenLink
              screen={screen}
              counts={scorecard(report, screen.id).confirmed}
              isCurrent={screen.id === currentId}
              isBeingInspected={isInspecting(report, screen)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
});
