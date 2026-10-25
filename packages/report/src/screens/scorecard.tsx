import { Info } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type Scorecard as ScorecardData, SEVERITY_ORDER } from '@/data/selectors';
import { Candidates } from '@/findings/candidates';
import { cn } from '@/lib/utils';
import { SEVERITY_DOT, SEVERITY_LABEL } from './severity';

/*
 * One screen's numbers (`selectors.scorecard`): its confirmed findings by severity, the worth-a-look
 * entries, how many confirmed findings reproduced every time, how many the judge rejected (with why they
 * are not shown), and the most frequent reasons the lenses skipped something. A solid surface.
 */

export interface ScorecardProps {
  readonly card: ScorecardData;
  /** The card's heading, which names it. Default `Scorecard`. */
  readonly title?: string;
  /** What the numbers are of: one screen (the default), or the whole run. */
  readonly scope?: 'screen' | 'run';
  /** The judge was turned off: the candidates are listed as such, not as being reproduced. */
  readonly isJudgeOff?: boolean;
}

const SCOPE_PHRASE = { screen: 'on this screen', run: 'in this run' } as const;

/** The skip reasons shown, the most frequent first. */
export const TOP_SKIP_REASONS = 3;
export const REJECTED_EXPLAINED =
  'Rejected by the judge: measured but not reproduced three times or attributed to the explorer, so not shown';

function Stat({
  term,
  value,
  marker,
  hint,
}: {
  readonly term: string;
  readonly value: number;
  readonly marker?: string;
  readonly hint?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-bg-2 px-3 py-2">
      <dt className="flex items-center gap-1.5 text-[12px] text-ink-2">
        {marker === undefined ? null : (
          <span aria-hidden="true" className={cn('size-2 rounded-full', marker)} />
        )}
        {term}
        {hint}
      </dt>
      <dd className="m-0 font-bold font-mono text-[20px] text-ink leading-7">{value}</dd>
    </div>
  );
}

/** Why the rejected findings are not shown, as a tooltip on an info button (the Findings view's count too). */
export function RejectedHint() {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Why rejected findings are not shown"
        className="-my-1 inline-grid size-6 cursor-help place-items-center rounded-full text-ink-2 hover:text-ink"
      >
        <Info aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{REJECTED_EXPLAINED}</TooltipContent>
    </Tooltip>
  );
}

function Skipped({
  skipped,
  scope,
}: {
  readonly skipped: ScorecardData['skipped'];
  readonly scope: 'screen' | 'run';
}) {
  const titleId = useId();
  const top = skipped.slice(0, TOP_SKIP_REASONS);
  const others = skipped.slice(TOP_SKIP_REASONS).reduce((sum, { count }) => sum + count, 0);
  return (
    <div className="mt-3">
      <h3 id={titleId} className="font-semibold text-[13.5px]">
        Skipped
      </h3>
      {top.length === 0 ? (
        <p className="mt-0.5 text-[12.5px] text-ink-2">{`The lenses skipped nothing ${SCOPE_PHRASE[scope]}.`}</p>
      ) : (
        <ul aria-labelledby={titleId} className="mt-1 grid gap-0.5 text-[12.5px]">
          {top.map(({ reason, count }) => (
            <li key={reason} className="flex items-baseline justify-between gap-3">
              <code className="min-w-0 break-all font-mono text-ink-2">{reason}</code>
              <span className="font-mono text-ink">{count}</span>
            </li>
          ))}
          {others === 0 ? null : <li className="text-ink-2">{`and ${others} more for other reasons`}</li>}
        </ul>
      )}
    </div>
  );
}

export function Scorecard({
  card,
  title = 'Scorecard',
  scope = 'screen',
  isJudgeOff = false,
}: ScorecardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-line bg-bg-1 p-4">
      <h2 id={titleId} className="font-semibold text-[15px]">
        {title}
      </h2>
      <h3 className="mt-2 font-semibold text-[13.5px]">Confirmed</h3>
      <dl className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {SEVERITY_ORDER.map((severity) => (
          <Stat
            key={severity}
            term={SEVERITY_LABEL[severity]}
            value={card.confirmed[severity]}
            marker={SEVERITY_DOT[severity]}
          />
        ))}
      </dl>
      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat term="Reproduced 3/3" value={card.reproducedEveryTime} />
        <Stat term="Worth a look" value={card.worthALook} />
        <Stat term="Rejected" value={card.rejected} hint={<RejectedHint />} />
      </dl>
      <Candidates findings={card.candidates} isJudgeOff={isJudgeOff} level={3} className="mt-3" />
      <Skipped skipped={card.skipped} scope={scope} />
    </section>
  );
}
