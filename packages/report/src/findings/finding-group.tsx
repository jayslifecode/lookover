import type { Finding } from '@jayslifecode/lookover-core';
import { type ReactNode, useId } from 'react';
import { formatRoute } from '@/data/route';
import { type FindingGroup as Group, routesOf } from '@/data/selectors';
import { cn } from '@/lib/utils';
import { SEVERITY_DOT, SEVERITY_LABEL } from '@/screens/severity';

/*
 * One fix-first group of the Findings view (a solid surface): what it is about, as a button that opens
 * it — its severity, its lead finding's title, its signature (or component, or rule) and how many screens
 * it is on, and how many findings it holds. Open, it lists each finding as a link that selects it, with
 * the element it is about and the route it is on.
 */

export interface FindingGroupProps {
  readonly group: Group;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  /** The route's selected finding. */
  readonly selectedId: string | null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What one finding of a group is about: its element, or for an occurrence finding how often it was seen. */
export function subjectOf(finding: Finding): string {
  if (finding.shape === 'occurrence') return plural(finding.occurrences.length, 'occurrence', 'occurrences');
  const target = finding.target;
  if (target === null) return finding.title;
  return target.name === '' ? target.role : `${target.role} "${target.name}"`;
}

/** A finding on one line: its severity, its title and the routes it was seen on. */
export function FindingLine({ finding }: { readonly finding: Finding }) {
  return (
    <>
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
        <span aria-hidden="true" className={cn('size-2 rounded-full', SEVERITY_DOT[finding.severity])} />
        {SEVERITY_LABEL[finding.severity]}
      </span>
      <span>{finding.title}</span>
      <span className="font-mono text-[12px] text-ink-2">{routesOf(finding).join(', ')}</span>
    </>
  );
}

/** A link that selects `finding` in the Findings view. */
export function FindingLink({
  finding,
  selectedId,
  children,
}: {
  readonly finding: Finding;
  readonly selectedId: string | null;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={formatRoute({ view: 'findings', findingId: finding.id })}
      aria-current={finding.id === selectedId ? 'true' : undefined}
      className="flex min-h-8 flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1 text-[13px] text-ink hover:bg-bg-2 aria-[current=true]:bg-bg-2 aria-[current=true]:ring-1 aria-[current=true]:ring-accent"
    >
      {children}
    </a>
  );
}

export function FindingGroup({ group, isExpanded, onToggle, selectedId }: FindingGroupProps) {
  const listId = useId();
  const { lead, severity } = group;
  return (
    <li className="rounded-lg border border-line bg-bg-1">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={isExpanded ? listId : undefined}
        onClick={onToggle}
        className="flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg p-3 text-left hover:bg-bg-2"
      >
        <span className="flex w-16 shrink-0 items-center gap-1.5 pt-0.5 text-[12px] text-ink-2">
          <span aria-hidden="true" className={cn('size-2 rounded-full', SEVERITY_DOT[severity])} />
          {SEVERITY_LABEL[severity]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[14px] text-ink">{lead.title}</span>
          <span className="block break-all font-mono text-[12px] text-ink-2">
            {`${group.label} · ${plural(group.screens.length, 'screen', 'screens')}`}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-[12px] text-ink-2">
          {plural(group.count, 'finding', 'findings')}
        </span>
      </button>
      {isExpanded ? (
        <ul id={listId} className="m-0 grid list-none gap-0.5 border-line border-t px-2 py-2">
          {group.findings.map((finding) => (
            <li key={finding.id}>
              <FindingLink finding={finding} selectedId={selectedId}>
                <span>{subjectOf(finding)}</span>
                <span className="font-mono text-[12px] text-ink-2">{routesOf(finding).join(', ')}</span>
              </FindingLink>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
