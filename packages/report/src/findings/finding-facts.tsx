import type { Finding, Viewport } from '@jayslifecode/lookover-core';
import type { ReactNode } from 'react';
import { ruleReference } from '@/data/rules';
import { cn } from '@/lib/utils';
import { MAX_FACT_LINES, useMeasuredFacts } from './measured-facts';
import { GLASS_LINK, PANEL_SECTION } from './panel-styles';

/*
 * The finding's facts, as the panel's key-value block (the motion study's `.kv`): the rule with the
 * standard it applies, the element and its selector, the React component, the signature it shares with
 * look-alike controls, what the lens measured, and the viewport. Occurrence findings have no single
 * element, so they show the rule, the measured facts and their viewports. All text is --ink: it is on glass.
 */

const CODE = 'block break-all font-mono text-[11.5px]';

/** A term and its value; the pair is the `dt`/`dd` the panel's tests and screen readers read. */
export function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold">{term}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

function viewportText({ name, width, height }: Viewport): string {
  return `${name} · ${width}×${height}`;
}

function viewportsOf(finding: Finding): string {
  if (finding.shape === 'step') return viewportText(finding.trace.viewport);
  return [...new Set(finding.occurrences.map((occurrence) => viewportText(occurrence.viewport)))].join(', ');
}

function RuleFact({ ruleId }: { readonly ruleId: string }) {
  const reference = ruleReference(ruleId);
  return (
    <>
      {reference === null ? null : (
        <a
          href={reference.url}
          target="_blank"
          rel="noreferrer"
          className={cn(GLASS_LINK, 'inline-flex min-h-6 items-center')}
        >
          {`${reference.standard} · ${reference.criterion}`}
        </a>
      )}
      <code className={CODE}>{ruleId}</code>
    </>
  );
}

function MeasuredFact({ finding }: { readonly finding: Finding }) {
  const facts = useMeasuredFacts(finding);
  if (facts.status === 'none') return null;
  return (
    <Fact term="Measured">
      {facts.status === 'loading' ? (
        'Loading…'
      ) : facts.status === 'failed' ? (
        'The measurements could not be loaded.'
      ) : (
        <ul
          aria-label={`Measured facts, the first ${MAX_FACT_LINES}`}
          className="m-0 grid list-none gap-0.5 p-0"
        >
          {facts.lines.map((line) => (
            <li key={line}>
              <code className={CODE}>{line}</code>
            </li>
          ))}
          {facts.more === 0 ? null : <li>{`and ${facts.more} more`}</li>}
        </ul>
      )}
    </Fact>
  );
}

export function FindingFacts({ finding }: { readonly finding: Finding }) {
  const target = finding.shape === 'step' ? finding.target : null;
  return (
    <dl
      className={`m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] ${PANEL_SECTION}`}
    >
      <Fact term="Rule">
        <RuleFact ruleId={finding.rule.id} />
      </Fact>
      {target === null ? null : (
        <Fact term="Element">
          <span className="block">
            {target.name === '' ? target.role : `${target.role} "${target.name}"`}
          </span>
          <code className={CODE}>{target.selector}</code>
        </Fact>
      )}
      {target?.componentName == null ? null : (
        <Fact term="Component">
          <code className={CODE}>{`<${target.componentName}>`}</code>
        </Fact>
      )}
      {target?.signature == null ? null : (
        <Fact term="Signature">
          <code className={CODE}>{target.signature}</code>
        </Fact>
      )}
      <MeasuredFact finding={finding} />
      <Fact term="Viewport">{viewportsOf(finding)}</Fact>
    </dl>
  );
}
