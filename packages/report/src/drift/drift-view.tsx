import type { Finding } from '@jayslifecode/lookover-core';
import { useId, useMemo } from 'react';
import type { ReportState } from '@/data/reduce';
import { compareSeverity, type Drift, drift, isWorthALook } from '@/data/selectors';
import { FindingLine, FindingLink } from '@/findings/finding-group';
import { cn } from '@/lib/utils';
import { EMPTY_BOX, FirstRun } from '@/shell/empty-states';

/*
 * The Drift view (`#/drift`): this run against the previous one. New (confirmed now, not then), Fixed
 * (confirmed then, neither confirmed nor intended now), Still there (confirmed in both), the findings
 * marked intended since (never counted as fixed), and the routes that came and went. Each finding links
 * to it in the Findings view; a fixed one this run no longer holds is shown as it was. While the run is
 * going, New and Still there come from what is judged so far, and Fixed and Removed are held: a finding
 * or a route the run has not reached yet is not gone. A first run says there is nothing to compare it
 * with, and how to get a comparison. Solid surfaces throughout.
 */

export interface DriftViewProps {
  readonly report: ReportState;
}

const SECTION = 'rounded-lg border border-line bg-bg-1 p-4';
const LIST = 'm-0 mt-2 grid list-none gap-0.5 p-0';
const HELD = 'Fixed and removed are known when the run finishes.';
const ROUTES_EXPLAINED =
  "Compared by the routes the previous run's findings name: the report has no copy of the previous run's screen map, so a route it captured without a finding shows as added.";

function bySeverity(findings: readonly Finding[]): Finding[] {
  return findings.toSorted(compareSeverity);
}

/**
 * A finding this run judged (or set aside as worth a look) links to it; one it does not hold is shown as
 * it was in the previous run.
 */
function DriftEntry({ report, finding }: { readonly report: ReportState; readonly finding: Finding }) {
  if (report.judged.has(finding.id) || isWorthALook(report, finding.id)) {
    return (
      <FindingLink finding={finding} selectedId={null}>
        <FindingLine finding={finding} />
      </FindingLink>
    );
  }
  return (
    <div className="flex min-h-8 flex-wrap items-baseline gap-x-2 px-2 py-1 text-[13px] text-ink">
      <FindingLine finding={finding} />
      <span className="text-[12px] text-ink-2">not in this run</span>
    </div>
  );
}

function DriftSection({
  report,
  title,
  findings,
  emptyText,
  className,
}: {
  readonly report: ReportState;
  readonly title: string;
  /** `null`: held until the run finishes. */
  readonly findings: readonly Finding[] | null;
  readonly emptyText: string;
  readonly className?: string;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn(SECTION, className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={titleId} className="m-0 font-semibold text-[15px]">
          {title}
        </h2>
        {findings === null ? null : (
          <span className="font-mono text-[13px] text-ink-2">{findings.length}</span>
        )}
      </div>
      {findings === null || findings.length === 0 ? (
        <p className="m-0 mt-1 text-[13px] text-ink-2">{findings === null ? HELD : emptyText}</p>
      ) : (
        <ul className={LIST}>
          {bySeverity(findings).map((finding) => (
            <li key={finding.id}>
              <DriftEntry report={report} finding={finding} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RouteList({
  title,
  routes,
  emptyText,
}: {
  title: string;
  /** `null`: held until the run finishes. */
  routes: readonly string[] | null;
  emptyText: string;
}) {
  const titleId = useId();
  return (
    <div className="min-w-0">
      <h3 id={titleId} className="m-0 font-semibold text-[13.5px]">
        {title}
      </h3>
      {routes === null || routes.length === 0 ? (
        <p className="m-0 mt-0.5 text-[13px] text-ink-2">{routes === null ? HELD : emptyText}</p>
      ) : (
        <ul aria-labelledby={titleId} className={LIST}>
          {routes.map((route) => (
            <li key={route}>
              <code className="break-all font-mono text-[12.5px] text-ink">{route}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutesSection({ changes }: { readonly changes: Drift }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn(SECTION, 'md:col-span-2')}>
      <h2 id={titleId} className="m-0 font-semibold text-[15px]">
        Screens by route
      </h2>
      <p className="m-0 mt-0.5 max-w-[72ch] text-[13px] text-ink-2">{ROUTES_EXPLAINED}</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <RouteList title="Added" routes={changes.addedRoutes} emptyText="No route is new." />
        <RouteList title="Removed" routes={changes.removedRoutes} emptyText="No route is gone." />
      </div>
    </section>
  );
}

function Comparison({ report, changes }: { readonly report: ReportState; readonly changes: Drift }) {
  const isGoing = changes.fixed === null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <DriftSection
        report={report}
        title="New"
        findings={changes.added}
        emptyText={isGoing ? 'Nothing new so far.' : 'Nothing new since the last run.'}
        className="md:col-span-2"
      />
      <DriftSection
        report={report}
        title="Fixed"
        findings={changes.fixed}
        emptyText="Nothing was fixed since the last run."
      />
      <DriftSection
        report={report}
        title="Still there"
        findings={changes.unchanged}
        emptyText={
          isGoing
            ? 'Nothing from the last run confirmed again so far.'
            : 'Nothing from the last run is still there.'
        }
      />
      {changes.intended.length === 0 ? null : (
        <DriftSection
          report={report}
          title="Intended"
          findings={changes.intended}
          emptyText=""
          className="md:col-span-2"
        />
      )}
      <RoutesSection changes={changes} />
    </div>
  );
}

function summaryOf(previousRunId: string, changes: Drift | null): string {
  if (changes === null) return `Compared with the run ${previousRunId}.`;
  const { added, fixed, unchanged } = changes;
  if (fixed === null) {
    return `Since the run ${previousRunId}, so far: ${added.length} new · ${unchanged.length} still there`;
  }
  return `Since the run ${previousRunId}: ${added.length} new · ${fixed.length} fixed · ${unchanged.length} still there`;
}

function DriftBody({ report, changes }: { readonly report: ReportState; readonly changes: Drift | null }) {
  if (report.manifest?.previousRunId == null) return <FirstRun />;
  const error = report.errors.find((known) => known.source === 'previous');
  if (error !== undefined) {
    return (
      <div role="alert" className={EMPTY_BOX}>
        <p className="m-0 font-semibold">The previous run's findings could not be loaded</p>
        <p className="m-0 mt-1 text-ink-2">{error.message}</p>
      </div>
    );
  }
  if (changes === null) {
    return <p className={cn(EMPTY_BOX, 'm-0 text-ink-2')}>Loading the previous run's findings…</p>;
  }
  return <Comparison report={report} changes={changes} />;
}

export function DriftView({ report }: DriftViewProps) {
  const changes = useMemo(() => drift(report), [report]);
  const previousRunId = report.manifest?.previousRunId ?? null;
  return (
    <div className="grid gap-4">
      <header>
        <h1 className="m-0 font-bold text-2xl tracking-tight">Drift</h1>
        {previousRunId === null ? null : (
          <p className="m-0 mt-1 text-ink-2">{summaryOf(previousRunId, changes)}</p>
        )}
        {report.run.status === 'running' && previousRunId !== null ? (
          <p className="m-0 mt-1 text-ink-2">
            The run is still going: this compares what is confirmed so far.
          </p>
        ) : null}
      </header>
      <DriftBody report={report} changes={changes} />
    </div>
  );
}
