import type { JudgeTotals } from '@jayslifecode/lookover-core';
import type { ReportState } from '@/data/reduce';
import { confirmedFindings, intendedFindings, rejectedFindings, SEVERITY_ORDER } from '@/data/selectors';
import { formatUsd } from '@/lib/usd';
import { SEVERITY_LABEL } from '@/screens/severity';
import { Fact } from './finding-facts';
import { PANEL_SECTION } from './panel-styles';

/*
 * What the panel shows with no finding chosen, so it is never empty: the run in numbers (screens,
 * confirmed findings by severity, intended, rejected, worth a look) and what the judge model cost, or
 * that it was not used.
 */

export interface PanelSummaryProps {
  readonly report: ReportState;
  /** The id of the heading the panel is labelled by. */
  readonly titleId: string;
  /** A finding the route asked for that the run does not have. */
  readonly missingId: string | null;
}

const UNAVAILABLE_REASON: Readonly<Record<NonNullable<JudgeTotals['unavailable']>, string>> = {
  'no-api-key': 'no API key',
  disabled: 'turned off',
  'api-error': 'the API failed',
};
const FAILED_PARTWAY = 'the model failed partway; reproduction alone decided the rest';

function confirmedText(report: ReportState): string {
  const confirmed = confirmedFindings(report);
  const parts = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: confirmed.filter((finding) => finding.severity === severity).length,
  }))
    .filter(({ count }) => count > 0)
    .map(({ severity, count }) => `${count} ${SEVERITY_LABEL[severity].toLowerCase()}`);
  return parts.length === 0 ? 'None' : parts.join(' · ');
}

/**
 * The judge's cost line; `null` while the run has no totals (it is still going, or was not judged). A
 * model that answered and then failed keeps its cost, said to have failed partway.
 */
function costLine(totals: JudgeTotals | null): string | null {
  if (totals === null) return null;
  if (totals.model === null && totals.unavailable !== null) {
    const reason = UNAVAILABLE_REASON[totals.unavailable];
    return `The judge model was not used (${reason}): reproduction alone confirmed the findings.`;
  }
  const model = totals.model ?? 'the judge model';
  const calls = `${totals.calls} ${totals.calls === 1 ? 'call' : 'calls'}`;
  const cost = totals.estimatedUsd === null ? 'cost unknown' : formatUsd(totals.estimatedUsd);
  const line = `Judged by ${model} · ${calls} · ${cost}`;
  return totals.unavailable === 'api-error' ? `${line} · ${FAILED_PARTWAY}` : line;
}

export function PanelSummary({ report, titleId, missingId }: PanelSummaryProps) {
  const cost = costLine(report.totals);
  return (
    <div className="grid gap-2.5">
      <div>
        <h2 id={titleId} className="m-0 font-bold text-[16px] leading-[1.3] tracking-[-0.01em]">
          Run summary
        </h2>
        <p className="m-0 mt-1 text-[13px]">
          {missingId === null
            ? 'Choose a pin on a screenshot, or a finding in a list, to read it here.'
            : `This run has no finding ${missingId}.`}
        </p>
      </div>
      <dl
        className={`m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] ${PANEL_SECTION}`}
      >
        <Fact term="Screens">{String(report.screens.length)}</Fact>
        <Fact term="Confirmed">{confirmedText(report)}</Fact>
        <Fact term="Intended">{String(intendedFindings(report).length)}</Fact>
        <Fact term="Rejected">{String(rejectedFindings(report).length)}</Fact>
        <Fact term="Worth a look">{String(report.worthALook.length)}</Fact>
      </dl>
      {cost === null ? null : <p className={`m-0 text-[12.5px] ${PANEL_SECTION}`}>{cost}</p>}
    </div>
  );
}
