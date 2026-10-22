import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/motion/reduced';

/*
 * Where the run is. While it runs, the dot pulses: the only motion in the report nobody asked for
 * (spec §11), a separate element animated with transform and opacity, and none under reduced motion.
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

export function LiveIndicator({ status }: { status: LiveStatus }) {
  const isReducedMotion = useReducedMotion();
  const isPulsing = RUNNING.has(status) && !isReducedMotion;
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
    </output>
  );
}
