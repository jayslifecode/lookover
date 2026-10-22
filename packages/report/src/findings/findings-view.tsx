import type { Finding } from '@jayslifecode/lookover-core';
import { useId, useMemo, useState } from 'react';
import type { ReportState } from '@/data/reduce';
import {
  confirmedFindings,
  fixFirst,
  type FindingGroup as Group,
  groups,
  intendedFindings,
  rejectedFindings,
} from '@/data/selectors';
import { cn } from '@/lib/utils';
import { RejectedHint } from '@/screens/scorecard';
import { SEVERITY_DOT, SEVERITY_LABEL } from '@/screens/severity';
import { type FindingFilters, isFiltered, matchesFilters, NO_FILTERS, routesOf } from './filter';
import { FindingGroup, FindingLink } from './finding-group';
import { FindingPanel } from './finding-panel';
import { FindingsFilters } from './findings-filters';

/*
 * The Findings view (`#/findings?f=<findingId>`): the confirmed findings in fix-first groups (one per
 * component the findings share, the most severe and widespread first), narrowed by severity, lens and a
 * search, or the findings the user marked intended; the lower-confidence entries in a section of their
 * own when the Worth a look switch is on, never mixed with the findings. A chosen finding shows in the
 * panel beside the list from `xl`, below it on a phone. Everything here but the panel is solid.
 */

export interface FindingsViewProps {
  readonly report: ReportState;
  /** The route's selected finding. */
  readonly findingId: string | null;
}

export const WORTH_A_LOOK_KEY = 'lookover.worthALook';

function readWorthALook(): boolean {
  try {
    return window.localStorage.getItem(WORTH_A_LOOK_KEY) === 'true';
  } catch {
    // Storage is blocked (a private window, a site-data policy): the switch starts off.
    return false;
  }
}

function writeWorthALook(isShown: boolean): void {
  try {
    window.localStorage.setItem(WORTH_A_LOOK_KEY, String(isShown));
  } catch {
    // Storage is blocked: the switch still works for this page, it is just not remembered.
  }
}

/** The Worth a look switch, remembered in localStorage where the browser allows it. */
function useWorthALook(): readonly [boolean, (isShown: boolean) => void] {
  const [isShown, setShown] = useState(readWorthALook);
  const change = (next: boolean) => {
    setShown(next);
    writeWorthALook(next);
  };
  return [isShown, change];
}

function CountLine({ report }: { readonly report: ReportState }) {
  const confirmed = confirmedFindings(report).length;
  const intended = intendedFindings(report).length;
  const rejected = rejectedFindings(report).length;
  return (
    <p className="m-0 mt-1 flex flex-wrap items-center gap-1 text-ink-2">
      <span>{`${confirmed} confirmed · ${intended} intended · ${rejected} rejected by the judge`}</span>
      <RejectedHint />
    </p>
  );
}

function emptyText(report: ReportState, filters: FindingFilters): string {
  if (isFiltered(filters)) return 'No finding matches these filters.';
  return filters.status === 'confirmed' && report.run.status === 'running'
    ? 'No finding has been confirmed yet.'
    : `No finding is ${filters.status}.`;
}

function WorthALook({
  report,
  filters,
  selectedId,
}: {
  readonly report: ReportState;
  readonly filters: FindingFilters;
  readonly selectedId: string | null;
}) {
  const titleId = useId();
  const entries = report.worthALook.filter((entry) => matchesFilters(entry, filters));
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-line bg-bg-1 p-4">
      <h2 id={titleId} className="m-0 font-semibold text-[15px]">
        Worth a look
      </h2>
      <p className="m-0 mt-0.5 text-[13px] text-ink-2">
        Lower-confidence entries: measured, but not reproduced or judged, so not findings.
      </p>
      {entries.length === 0 ? (
        <p className="m-0 mt-2 text-[13px] text-ink-2">
          {report.worthALook.length === 0
            ? 'Nothing was set aside as worth a look.'
            : 'No entry matches these filters.'}
        </p>
      ) : (
        <ul className="m-0 mt-2 grid list-none gap-0.5 p-0">
          {entries.map((entry) => (
            <li key={entry.id}>
              <FindingLink finding={entry} selectedId={selectedId}>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span
                    aria-hidden="true"
                    className={cn('size-2 rounded-full', SEVERITY_DOT[entry.severity])}
                  />
                  {SEVERITY_LABEL[entry.severity]}
                </span>
                <span>{entry.title}</span>
                <span className="font-mono text-[12px] text-ink-2">{routesOf(entry).join(', ')}</span>
              </FindingLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function listed(report: ReportState, filters: FindingFilters): Finding[] {
  const findings = filters.status === 'confirmed' ? confirmedFindings(report) : intendedFindings(report);
  return findings.filter((finding) => matchesFilters(finding, filters));
}

export function FindingsView({ report, findingId }: FindingsViewProps) {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [isWorthALookShown, setWorthALookShown] = useWorthALook();
  // Opened or closed by the reader; a group not toggled yet is open when it holds the chosen finding.
  const [toggledOpen, setToggledOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const fixFirstGroups = useMemo(() => fixFirst(groups(listed(report, filters))), [report, filters]);
  const isOpen = (group: Group) =>
    toggledOpen.get(group.key) ?? group.findings.some((finding) => finding.id === findingId);
  const toggle = (group: Group) => setToggledOpen((known) => new Map(known).set(group.key, !isOpen(group)));

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="grid min-w-0 gap-4">
        <header>
          <h1 className="m-0 font-bold text-2xl tracking-tight">Findings</h1>
          <CountLine report={report} />
        </header>
        <FindingsFilters
          filters={filters}
          onChange={setFilters}
          isWorthALookShown={isWorthALookShown}
          onWorthALookChange={setWorthALookShown}
        />
        {fixFirstGroups.length === 0 ? (
          <p className="m-0 rounded-lg border border-line bg-bg-1 p-4 text-ink-2">
            {emptyText(report, filters)}
          </p>
        ) : (
          <ul aria-label="Fix first" className="m-0 grid list-none gap-2 p-0">
            {fixFirstGroups.map((group) => (
              <FindingGroup
                key={group.key}
                group={group}
                isExpanded={isOpen(group)}
                onToggle={() => toggle(group)}
                selectedId={findingId}
              />
            ))}
          </ul>
        )}
        {isWorthALookShown ? <WorthALook report={report} filters={filters} selectedId={findingId} /> : null}
      </div>
      <FindingPanel report={report} findingId={findingId} />
    </div>
  );
}
