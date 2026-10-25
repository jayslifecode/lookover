import type { Finding } from '@jayslifecode/lookover-core';
import { useId } from 'react';
import { cn } from '@/lib/utils';
import { FindingLine } from './finding-group';

/*
 * What the lenses saw and nothing has judged, under a heading of its own and never as a finding (no
 * link, no pin, not counted). While a judged run is going they are being reproduced, each marked
 * `reproducing…`, and the list empties as they are judged. With the judge turned off (`--no-judge`)
 * nothing will reproduce them: they are listed as candidates, for good. The Findings view and a screen's
 * scorecard show it.
 */

export interface CandidatesProps {
  readonly findings: readonly Finding[];
  /** The judge was turned off: the candidates will not be reproduced. */
  readonly isJudgeOff: boolean;
  /** The heading's level where it sits: a section of the view (2), or a part of the scorecard (3). */
  readonly level: 2 | 3;
  readonly className?: string;
}

const TEXT = {
  reproducing: {
    title: 'Being reproduced',
    note: 'Seen by the lenses and not judged yet: none is a finding until it reproduces.',
  },
  judgeOff: {
    title: 'Candidates (judge off)',
    note: 'Seen by the lenses; the judge was turned off, so none was reproduced or judged.',
  },
} as const;

export function Candidates({ findings, isJudgeOff, level, className }: CandidatesProps) {
  const titleId = useId();
  if (findings.length === 0) return null;
  const Heading = level === 2 ? 'h2' : 'h3';
  const { title, note } = isJudgeOff ? TEXT.judgeOff : TEXT.reproducing;
  return (
    <div className={className}>
      <Heading
        id={titleId}
        className={cn('m-0 font-semibold', level === 2 ? 'text-[15px]' : 'text-[13.5px]')}
      >
        {title}
      </Heading>
      <p className="m-0 mt-0.5 text-[12.5px] text-ink-2">{note}</p>
      <ul aria-labelledby={titleId} className="m-0 mt-1.5 grid list-none gap-0.5 p-0">
        {findings.map((finding) => (
          <li
            key={finding.id}
            className="flex min-h-8 flex-wrap items-baseline gap-x-2 px-2 py-1 text-[13px] text-ink"
          >
            <FindingLine finding={finding} />
            {isJudgeOff ? null : <span className="text-[12px] text-ink-2">reproducing…</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
