import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * What the report shows where there is nothing to show yet (spec §11): each says what to do next, in
 * plain words, on a solid surface. Nothing here moves.
 */

/** A solid box for a state that stands in place of a view or a list. */
export const EMPTY_BOX = 'rounded-lg border border-line bg-bg-1 p-6';

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
