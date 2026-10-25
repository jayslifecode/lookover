import type { JudgeTotals } from '@jayslifecode/lookover-core';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ON_GLASS_FOCUS } from '@/findings/panel-styles';

/*
 * What the judge model cost the run, in the top bar: `34 calls · 61k tokens · ≈ $0.19`, with a tooltip
 * that breaks it down (the model, the calls and cache hits, each kind of token), or why the model was
 * not used. As the CLI's summary does, a model that answered and then failed keeps its cost, marked
 * `· judge model failed partway`; only a model never asked (no model in the totals) reads as not used.
 * The totals come with the end of the run, so a run still going (or one that failed before it ended)
 * shows nothing, unless the judge was turned off, which the run says when it starts. Its text is --ink,
 * the ink that reads on the glass bar over any content.
 */

export interface CostReadoutProps {
  /** The run's judge totals; `null` for a run not judged, or one that has not finished. */
  readonly totals: JudgeTotals | null;
  /** Whether the run finished: only then do no totals mean the judge model was off. */
  readonly isFinished: boolean;
  /** Why the judge model is not used, as the run said (`judge.unavailable`), before its totals come. */
  readonly judgeUnavailable?: JudgeTotals['unavailable'];
}

const TOKENS_PER_K = 1_000;
const USD_DECIMALS = 2;
const NUMBER_LOCALE = 'en-US';
const OFF = 'judge model off';
const FAILED_PARTWAY = 'judge model failed partway';
const UNAVAILABLE_TEXT: Readonly<Record<NonNullable<JudgeTotals['unavailable']>, string>> = {
  disabled: OFF,
  'no-api-key': 'judge model not used (no API key)',
  'api-error': 'judge model unavailable',
};
const TOKEN_KINDS: readonly { readonly key: keyof JudgeTotals['usage']; readonly label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
];
const READOUT = 'whitespace-nowrap font-medium font-mono text-[11.5px] text-ink';

/** Exact under a thousand, then to the nearest thousand with `k`. */
export function formatTokens(count: number): string {
  return count < TOKENS_PER_K ? String(count) : `${Math.round(count / TOKENS_PER_K)}k`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function totalTokens({ usage }: JudgeTotals): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Whether the judge model was asked (the totals name it), or never needed: there is a cost to show. */
function isAsked(totals: JudgeTotals): boolean {
  return totals.model !== null || totals.unavailable === null;
}

export function costText(totals: JudgeTotals | null): string {
  if (totals === null) return OFF;
  if (!isAsked(totals) && totals.unavailable !== null) return UNAVAILABLE_TEXT[totals.unavailable];
  const cost =
    totals.estimatedUsd === null ? 'cost unknown' : `≈ $${totals.estimatedUsd.toFixed(USD_DECIMALS)}`;
  const parts = [
    plural(totals.calls, 'call', 'calls'),
    `${formatTokens(totalTokens(totals))} tokens`,
    cost,
    ...(totals.unavailable === 'api-error' ? [FAILED_PARTWAY] : []),
  ];
  return parts.join(' · ');
}

function Breakdown({ totals }: { readonly totals: JudgeTotals }) {
  return (
    <div className="grid gap-1">
      <p className="m-0 font-mono">{totals.model ?? 'the judge model'}</p>
      <p className="m-0">{`${plural(totals.calls, 'call', 'calls')}, ${totals.cacheHits} from the cache`}</p>
      <dl className="m-0 grid grid-cols-[auto_auto] gap-x-3">
        {TOKEN_KINDS.map(({ key, label }) => (
          <div key={key} className="contents">
            <dt>{label}</dt>
            <dd className="m-0 text-right font-mono">{totals.usage[key].toLocaleString(NUMBER_LOCALE)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function CostReadout({ totals, isFinished, judgeUnavailable = null }: CostReadoutProps) {
  const isTurnedOff = totals === null && judgeUnavailable === 'disabled';
  if (totals === null && !isFinished && !isTurnedOff) return null;
  const text = costText(totals);
  if (totals === null || !isAsked(totals)) return <span className={READOUT}>{text}</span>;
  return (
    <Tooltip>
      {/* At least 24 px tall, like every target, with the two-tone ring of a control on glass. */}
      <TooltipTrigger
        className={`${READOUT} ${ON_GLASS_FOCUS} inline-flex min-h-6 cursor-help items-center rounded-full bg-transparent px-1.5`}
      >
        {text}
      </TooltipTrigger>
      <TooltipContent>
        <Breakdown totals={totals} />
      </TooltipContent>
    </Tooltip>
  );
}
