import type { ReportState } from '@/data/reduce';
import { isJudgeOff } from '@/data/selectors';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/motion/reduced';

/*
 * Where the run is. While it runs, the dot pulses: the only motion in the report nobody asked for
 * (spec §11), a separate element animated with transform and opacity, and none under reduced motion,
 * nor once the page no longer follows the run (its stream stopped for good). While a dropped event stream
 * reconnects, a small `reconnecting…` says the page may be behind.
 */

export type LiveStatus = 'mapping' | 'inspecting' | 'judging' | 'done' | 'failed';

const LABEL: Readonly<Record<LiveStatus, string>> = {
  mapping: 'Mapping',
  inspecting: 'Inspecting',
  judging: 'Judging',
  done: 'Done',
  failed: 'Failed',
};

const DOT: Readonly<Record<LiveStatus, string>> = {
  mapping: 'bg-accent',
  inspecting: 'bg-accent',
  judging: 'bg-accent',
  done: 'bg-pass',
  failed: 'bg-high',
};

const RUNNING: ReadonlySet<LiveStatus> = new Set(['mapping', 'inspecting', 'judging']);

/**
 * The run's phase from what has arrived: mapping from `run.started`, inspecting from the first captured
 * screen, judging from the first candidate (judged or not) unless the judge was turned off, then done or
 * failed when the run closes.
 */
export function liveStatusOf(report: ReportState): LiveStatus {
  if (report.run.status === 'finished') return 'done';
  if (report.run.status === 'failed') return 'failed';
  const hasCandidates = report.candidates.size > 0 || report.judged.size > 0;
  if (hasCandidates && !isJudgeOff(report)) return 'judging';
  return report.screens.length > 0 ? 'inspecting' : 'mapping';
}

export interface LiveIndicatorProps {
  readonly status: LiveStatus;
  /** The run's event stream dropped and the browser is reconnecting it. */
  readonly isReconnecting?: boolean;
  /** Whether the page follows the run live; not once its stream stopped for good. */
  readonly isFollowing?: boolean;
}

export function LiveIndicator({ status, isReconnecting = false, isFollowing = true }: LiveIndicatorProps) {
  const isReducedMotion = useReducedMotion();
  const isPulsing = RUNNING.has(status) && isFollowing && !isReducedMotion;
  return (
    <output className="inline-flex shrink-0 items-center gap-2 font-semibold text-[12.5px] text-ink">
      <span className="relative inline-flex size-2" aria-hidden="true">
        {isPulsing ? (
          <span className={cn('absolute inset-0 animate-ping rounded-full', DOT[status])} />
        ) : null}
        <span className={cn('relative size-2 rounded-full', DOT[status])} />
      </span>
      <span className="sr-only">Run status: </span>
      {LABEL[status]}
      {isReconnecting ? (
        <>
          {' '}
          <span className="font-medium text-[11.5px]">reconnecting…</span>
        </>
      ) : null}
    </output>
  );
}
