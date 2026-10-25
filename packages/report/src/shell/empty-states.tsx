import type { ReactNode } from 'react';
import type { Scorecard as ScorecardData } from '@/data/selectors';
import { cn } from '@/lib/utils';
import { Scorecard } from '@/screens/scorecard';

/*
 * What the report shows where there is nothing to show yet (spec §11): each says what to do next, in
 * plain words, on a solid surface. Nothing here moves.
 */

/** A solid box for a state that stands in place of a view or a list. */
export const EMPTY_BOX = 'rounded-lg border border-line bg-bg-1 p-6';
const ACTION =
  'inline-flex min-h-8 cursor-pointer items-center rounded-md border border-line-strong bg-bg-2 px-3 font-semibold text-[12.5px] text-ink hover:bg-bg-0';

/** A command the reader types, in mono. */
export function Command({ children }: { readonly children: string }) {
  return (
    <code className="whitespace-nowrap rounded-[4px] border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[0.9em] text-ink">
      {children}
    </code>
  );
}

function EmptyText({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <p className={cn('m-0 max-w-[62ch] text-ink-2', className)}>{children}</p>;
}

/** The page when the server has no run to show. */
export function NoRunYet() {
  return (
    <div className={EMPTY_BOX}>
      <EmptyText className="text-[15px] text-ink">
        No run yet. Run <Command>lookover run</Command> in your project to review it.
      </EmptyText>
    </div>
  );
}

/** The Drift view of a project's first run. */
export function FirstRun() {
  return (
    <div className={EMPTY_BOX}>
      <EmptyText>
        This is the first run, so there is nothing to compare it with yet. Run <Command>lookover run</Command>{' '}
        again after a change to see what is new, fixed and still there.
      </EmptyText>
    </div>
  );
}

/** Under a screenshot with no confirmed finding on it. */
export function NothingOnScreen({ isRunning }: { readonly isRunning: boolean }) {
  return (
    <p className="m-0 rounded-lg border border-line bg-bg-1 px-4 py-3 text-ink-2">
      {isRunning ? 'Nothing confirmed on this screen yet' : 'Nothing confirmed on this screen'}
    </p>
  );
}

/** The Findings view when its filters leave nothing. */
export function NoMatches({ onClear }: { readonly onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg-1 p-4">
      <EmptyText>No findings match these filters</EmptyText>
      <button type="button" className={ACTION} onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}

export interface NothingConfirmedProps {
  /** The run's numbers. */
  readonly card: ScorecardData;
  /** The judge was turned off (`--no-judge`): nothing was tried, so nothing could be confirmed. */
  readonly isJudgeOff: boolean;
  readonly isWorthALookShown: boolean;
  readonly onShowWorthALook: () => void;
}

function WorthALookPointer({ card, isWorthALookShown, onShowWorthALook }: NothingConfirmedProps) {
  const count = card.worthALook;
  if (count === 0)
    return <EmptyText className="mt-1">Nothing was set aside as worth a look either.</EmptyText>;
  if (isWorthALookShown)
    return <EmptyText className="mt-1">The worth-a-look entries are listed below.</EmptyText>;
  const entries = count === 1 ? 'the worth-a-look entry' : `the ${count} worth-a-look entries`;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <EmptyText>The Worth a look switch above lists what was set aside with lower confidence.</EmptyText>
      <button type="button" className={ACTION} onClick={onShowWorthALook}>
        {`Show ${entries}`}
      </button>
    </div>
  );
}

function WhyNothing({ isJudgeOff }: { readonly isJudgeOff: boolean }) {
  if (!isJudgeOff) {
    return (
      <EmptyText className="text-ink">
        Nothing was confirmed in this run: nothing the lenses saw reproduced every time.
      </EmptyText>
    );
  }
  return (
    <EmptyText className="text-ink">
      The judge was turned off for this run, so nothing was reproduced or confirmed. Run{' '}
      <Command>lookover run</Command> without --no-judge to reproduce and judge the candidates.
    </EmptyText>
  );
}

/** The Findings view of a finished run that confirmed nothing: the run in numbers, and where to look. */
export function NothingConfirmed(props: NothingConfirmedProps) {
  return (
    <div className="grid gap-4">
      <div className={EMPTY_BOX}>
        <WhyNothing isJudgeOff={props.isJudgeOff} />
        <WorthALookPointer {...props} />
      </div>
      {/* The view lists the candidates itself, under the scorecard. */}
      <Scorecard card={{ ...props.card, candidates: [] }} title="Run scorecard" scope="run" />
    </div>
  );
}
