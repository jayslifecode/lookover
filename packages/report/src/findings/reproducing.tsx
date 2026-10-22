import type { Finding } from '@jayslifecode/lookover-core';
import { useId } from 'react';
import { cn } from '@/lib/utils';
import { FindingLine } from './finding-group';

/*
 * While the run is going, what the lenses saw and the judge has not decided yet: each candidate with
 * `reproducing…`, under a heading of its own and never as a finding (no link, no pin, not counted).
 * The Findings view and a screen's scorecard show it; it empties as the candidates are judged.
 */

export interface ReproducingProps {
  readonly findings: readonly Finding[];
  /** The heading's level where it sits: a section of the view (2), or a part of the scorecard (3). */
  readonly level: 2 | 3;
  readonly className?: string;
}

const TITLE = 'Being reproduced';

export function Reproducing({ findings, level, className }: ReproducingProps) {
  const titleId = useId();
  if (findings.length === 0) return null;
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={className}>
      <Heading
        id={titleId}
        className={cn('m-0 font-semibold', level === 2 ? 'text-[15px]' : 'text-[13.5px]')}
      >
        {TITLE}
      </Heading>
      <p className="m-0 mt-0.5 text-[12.5px] text-ink-2">
        Seen by the lenses and not judged yet: none is a finding until it reproduces.
      </p>
      <ul aria-labelledby={titleId} className="m-0 mt-1.5 grid list-none gap-0.5 p-0">
        {findings.map((finding) => (
          <li
            key={finding.id}
            className="flex min-h-8 flex-wrap items-baseline gap-x-2 px-2 py-1 text-[13px] text-ink"
          >
            <FindingLine finding={finding} />
            <span className="text-[12px] text-ink-2">reproducing…</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
