import type { Finding } from '@jayslifecode/lookover-core';
import { type Ref, type RefObject, useCallback, useEffect, useId, useRef } from 'react';
import type { ReportState } from '@/data/reduce';
import { findingById, isWorthALook } from '@/data/selectors';
import { Glass } from '@/glass/glass';
import { cn } from '@/lib/utils';
import { matchesMedia } from '@/motion/reduced';
import { SEVERITY_DOT, SEVERITY_EDGE, SEVERITY_LABEL } from '@/screens/severity';
import { ErrorBoundary } from '@/shell/error-boundary';
import { FindingActions } from './actions';
import { EvidenceStrip } from './evidence-strip';
import { Fact, FindingFacts } from './finding-facts';
import { FindingVerdict } from './finding-verdict';
import { PANEL_SECTION } from './panel-styles';
import { PanelSummary } from './panel-summary';

/*
 * The finding panel (spec §11): the third glass surface, refracting through the `lens` filter where the
 * browser can. It shows the chosen finding — its severity and lens, title, why it matters, the facts, how
 * it was reproduced and judged, its pictures, what was observed against what was expected, and the
 * actions — or, with nothing chosen, the run's summary: it is never empty. A worth-a-look entry is labelled
 * as one and can be copied and replayed, not decided. From `xl` the panel is a fixed box, 380 px wide and
 * the viewport's height less the top bar, stuck under the top bar with its body scrolling inside: the
 * glass never changes size, and the ghost that grows into it always matches it. Below `xl` it sits in
 * the page's flow, sized by its content, so a choice of finding scrolls it into view (below the top bar).
 *
 * `PanelContent` is what the panel holds; the Screens view also renders it into the solid ghost that
 * grows out of a pin (motion/container-transform.ts), so the copy and the real panel look the same.
 */

export interface FindingPanelProps {
  readonly report: ReportState;
  /** The chosen finding; `null` for the run's summary. */
  readonly findingId: string | null;
  /** Where the view places the panel in its grid. */
  readonly className?: string;
  /** The panel's content, which fades out while a new finding grows in. */
  readonly contentRef?: Ref<HTMLDivElement> | undefined;
}

/** The attribute that marks the panel, so the container transform can find where to land. */
export const PANEL_ATTRIBUTE = 'data-finding-panel';
export const PANEL_SELECTOR = `[${PANEL_ATTRIBUTE}]`;

/** Tailwind's `xl`, from which the panel is the fixed box below (and the transform may grow into it). */
export const FIXED_PANEL_QUERY = '(min-width: 80rem)';
const PANEL =
  'flex min-w-0 flex-col overflow-hidden rounded-[18px] text-ink xl:sticky xl:top-[84px] xl:h-[calc(100vh-100px)] xl:self-start';
const WORTH_A_LOOK = 'worth a look';

function SeverityBadge({ finding, isEntry }: { readonly finding: Finding; readonly isEntry: boolean }) {
  const { severity } = finding;
  return (
    <span
      className={cn(
        'mb-2.5 inline-flex items-center gap-1.5 rounded-[5px] border px-[7px] py-0.5 font-medium font-mono text-[11.5px]',
        SEVERITY_EDGE[severity],
      )}
    >
      <span aria-hidden="true" className={cn('size-2 rounded-full', SEVERITY_DOT[severity])} />
      {`${SEVERITY_LABEL[severity]} · ${finding.source}${isEntry ? ` · ${WORTH_A_LOOK}` : ''}`}
    </span>
  );
}

function FindingDetail({
  report,
  finding,
  titleId,
}: {
  readonly report: ReportState;
  readonly finding: Finding;
  readonly titleId: string;
}) {
  // A worth-a-look entry was set aside before judging: it is explained, and only findings are decided.
  const isEntry = isWorthALook(report, finding.id);
  return (
    <>
      <SeverityBadge finding={finding} isEntry={isEntry} />
      <h2 id={titleId} className="m-0 mb-1.5 font-bold text-[16px] leading-[1.3] tracking-[-0.01em]">
        {finding.title}
      </h2>
      <p className="m-0 mb-3 text-[13px]">{finding.whyItMatters}</p>
      <FindingFacts finding={finding} />
      {isEntry ? (
        <p className={`m-0 text-[12.5px] ${PANEL_SECTION}`}>
          A lower-confidence observation: measured, but not reproduced or judged, so not a finding.
        </p>
      ) : (
        <FindingVerdict finding={finding} />
      )}
      <EvidenceStrip evidence={finding.evidence} />
      <dl
        className={`m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] ${PANEL_SECTION}`}
      >
        <Fact term="Observed">{finding.observed}</Fact>
        <Fact term="Expected">{finding.expected}</Fact>
      </dl>
      <FindingActions report={report} finding={finding} canDecide={!isEntry} />
    </>
  );
}

export interface PanelContentProps {
  readonly report: ReportState;
  readonly findingId: string | null;
  /** The id the panel's heading takes, which labels the panel. */
  readonly titleId: string;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

/** The panel's header strip (the motion study's `.grab`, without the drag) and its scrolling body. */
export function PanelContent({ report, findingId, titleId, ref }: PanelContentProps) {
  const finding = findingId === null ? null : findingById(report, findingId);
  return (
    // Scrolled into view on a phone, it lands below the sticky top bar (up to three rows tall below `sm`).
    <div ref={ref} className="flex min-h-0 flex-1 scroll-mt-[156px] flex-col sm:scroll-mt-[88px]">
      <div className="flex items-center justify-between gap-3 border-line border-b px-4 pt-3 pb-2.5 font-medium font-mono text-[11.5px]">
        <span>
          {finding === null ? 'summary' : isWorthALook(report, finding.id) ? WORTH_A_LOOK : 'finding'}
        </span>
        <span className="truncate">{finding?.id ?? report.manifest?.runId ?? ''}</span>
      </div>
      <div data-panel-body="" className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-4">
        {finding === null ? (
          <PanelSummary report={report} titleId={titleId} missingId={findingId} />
        ) : (
          <FindingDetail key={finding.id} report={report} finding={finding} titleId={titleId} />
        )}
      </div>
    </div>
  );
}

/** `node` into `ref`, whichever kind of ref it is. */
function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === 'function') ref(node);
  else if (ref != null) (ref as RefObject<T | null>).current = node;
}

export function FindingPanel({ report, findingId, className, contentRef }: FindingPanelProps) {
  const titleId = useId();
  const content = useRef<HTMLDivElement | null>(null);
  const setContent = useCallback(
    (node: HTMLDivElement | null) => {
      content.current = node;
      assignRef(contentRef, node);
    },
    [contentRef],
  );
  // Below `xl` the panel is in the page's flow, maybe far below the pin or link chosen: bring it in.
  useEffect(() => {
    if (findingId === null || matchesMedia(FIXED_PANEL_QUERY)) return;
    // jsdom has no scrollIntoView.
    content.current?.scrollIntoView?.({ block: 'start' });
  }, [findingId]);
  return (
    <Glass lens as="aside" aria-labelledby={titleId} data-finding-panel="" className={cn(PANEL, className)}>
      {/* A finding that cannot be shown leaves the panel in place, with a notice; another one is tried afresh. */}
      <ErrorBoundary label="finding" resetKey={findingId} className="m-4">
        <PanelContent report={report} findingId={findingId} titleId={titleId} ref={setContent} />
      </ErrorBoundary>
    </Glass>
  );
}
