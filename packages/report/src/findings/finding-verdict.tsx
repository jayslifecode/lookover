import type { Attribution, Finding, Judgement } from '@jayslifecode/lookover-core';
import { PANEL_SECTION } from './panel-styles';

/*
 * How a finding was judged: the reproduction line (`Reproduced 3 of 3 · chromium 14x · 1440×900`), who
 * decided (the judge model, or the reproduction alone when no model was used), what the verdict put the
 * finding down to, and the judge's note. A user's decision has no reproduction; its note is shown with
 * the decision itself.
 */

const ATTRIBUTION_TEXT: Readonly<Record<Attribution, string>> = {
  'product-defect': 'Attributed to a product defect.',
  timing: 'Attributed to timing: it did not reproduce every time.',
  'explorer-error': "Attributed to the explorer's error, not to the app.",
  exemption: 'Attributed to an exemption the rule allows.',
};

function reproductionLine(judgement: Judgement | null): string | null {
  if (judgement === null) return 'Not reproduced or judged yet.';
  if (judgement.decidedBy === 'user') return null;
  const tried = `Reproduced ${judgement.reproduced} of ${judgement.of}`;
  const environment = judgement.environment;
  if (environment === null) return tried;
  const { width, height } = environment.viewport;
  return `${tried} · ${environment.browser} · ${width}×${height}`;
}

function decidedLine(finding: Finding, judgement: Judgement): string | null {
  if (judgement.decidedBy === 'model') return `Judged by ${judgement.model ?? 'the judge model'}`;
  if (judgement.decidedBy === 'user') return null;
  return finding.status === 'rejected'
    ? 'Rejected by reproduction; the judge model was not used'
    : 'Confirmed by reproduction; the judge model was not used';
}

/** A harness confirmation is a product defect by definition; the other verdicts say what they found. */
function attributionLine(finding: Finding, judgement: Judgement): string | null {
  if (judgement.attribution === null) return null;
  const isExplained = judgement.decidedBy === 'model' || finding.status === 'rejected';
  return isExplained ? ATTRIBUTION_TEXT[judgement.attribution] : null;
}

export function FindingVerdict({ finding }: { readonly finding: Finding }) {
  const { judgement } = finding;
  const reproduction = reproductionLine(judgement);
  const decided = judgement === null ? null : decidedLine(finding, judgement);
  const attribution = judgement === null ? null : attributionLine(finding, judgement);
  const note = judgement === null || judgement.decidedBy === 'user' ? null : judgement.note;
  if (reproduction === null && decided === null) return null;
  return (
    <div className={`grid gap-1 text-[12.5px] ${PANEL_SECTION}`}>
      {reproduction === null ? null : <p className="m-0 font-mono text-[11.5px]">{reproduction}</p>}
      {decided === null ? null : <p className="m-0 font-semibold">{decided}</p>}
      {attribution === null ? null : <p className="m-0">{attribution}</p>}
      {note === null ? null : <p className="m-0">{note}</p>}
    </div>
  );
}
