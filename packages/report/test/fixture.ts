import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Finding,
  FindingStatus,
  FindingsFile,
  OccurrenceFinding,
  RunEvent,
  RunEventBody,
  Severity,
  StepFinding,
} from '@jayslifecode/lookover-core';

/*
 * The fixture run (`fixtures/run`, a judged 3-screen bench run) read from disk, and findings built from
 * its own findings with only the fields a test cares about changed, so every other field is real.
 */

/** A plain path: under jsdom the global `URL` is jsdom's, which Node's file APIs do not take. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const SYNTHETIC_RUN_ID = 'test-run';
const EPOCH = Date.parse('2026-10-22T10:00:00.000Z');

function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

export function fixtureEvents(): RunEvent[] {
  return readFixture('run/run.jsonl')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunEvent);
}

export function fixtureFindings(): FindingsFile {
  return JSON.parse(readFixture('run/findings.json')) as FindingsFile;
}

export function fixturePreviousFindings(): FindingsFile {
  return JSON.parse(readFixture('previous-findings.json')) as FindingsFile;
}

/** The text of one of the fixture run's files, by its `EvidenceRef.path` (`evidence/…`). */
export function fixtureEvidenceText(path: string): string {
  return readFixture(join('run', path));
}

export function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

/** The ISO time of the synthetic event `seq`: one second apart. */
export function timeOf(seq: number): string {
  return new Date(EPOCH + seq * 1000).toISOString();
}

/** A synthetic event of the run `test-run`. */
export function eventOf(body: RunEventBody, seq: number): RunEvent {
  return { ...body, seq, at: timeOf(seq), runId: SYNTHETIC_RUN_ID } as RunEvent;
}

const TEMPLATE = fixtureFindings();
const STEP_TEMPLATE = TEMPLATE.findings.find((finding): finding is StepFinding => finding.shape === 'step');
const OCCURRENCE_TEMPLATE = TEMPLATE.findings.find(
  (finding): finding is OccurrenceFinding => finding.shape === 'occurrence',
);
if (STEP_TEMPLATE === undefined || OCCURRENCE_TEMPLATE === undefined) {
  throw new Error(
    'The fixture run needs a step finding and an occurrence finding to build test findings from',
  );
}

interface FindingOverrides {
  readonly id: string;
  readonly severity?: Severity;
  readonly ruleId?: string;
  readonly title?: string;
  readonly status?: FindingStatus;
}

export interface StepOverrides extends FindingOverrides {
  readonly screenId?: string;
  readonly signature?: string | null;
  readonly componentName?: string | null;
}

export interface OccurrenceOverrides extends FindingOverrides {
  readonly screens: readonly string[];
}

function base(template: Finding, overrides: FindingOverrides) {
  return {
    id: overrides.id,
    key: overrides.id,
    severity: overrides.severity ?? template.severity,
    rule: { ...template.rule, id: overrides.ruleId ?? template.rule.id },
    title: overrides.title ?? template.title,
    status: overrides.status ?? 'confirmed',
  };
}

/** A copy of the fixture's first step finding (status `confirmed` unless asked otherwise). */
export function stepFinding(overrides: StepOverrides): StepFinding {
  const template = STEP_TEMPLATE as StepFinding;
  const target = template.target;
  return {
    ...template,
    ...base(template, overrides),
    screenId: overrides.screenId ?? template.screenId,
    target:
      target === null
        ? null
        : {
            ...target,
            signature: overrides.signature === undefined ? target.signature : overrides.signature,
            componentName:
              overrides.componentName === undefined ? target.componentName : overrides.componentName,
          },
  };
}

/** A copy of the fixture's first occurrence finding, seen once on each of `screens`. */
export function occurrenceFinding(overrides: OccurrenceOverrides): OccurrenceFinding {
  const template = OCCURRENCE_TEMPLATE as OccurrenceFinding;
  const [occurrence] = template.occurrences;
  if (occurrence === undefined) throw new Error('The fixture occurrence finding has no occurrence');
  return {
    ...template,
    ...base(template, overrides),
    occurrences: overrides.screens.map((screenId) => ({ ...occurrence, screenId })),
  };
}

/** A findings file of the run `test-run` holding the given lists. */
export function findingsFile(
  lists: Partial<Pick<FindingsFile, 'findings' | 'worthALook' | 'rejected' | 'intended'>>,
) {
  return {
    ...TEMPLATE,
    runId: SYNTHETIC_RUN_ID,
    findings: lists.findings ?? [],
    worthALook: lists.worthALook ?? [],
    rejected: lists.rejected ?? [],
    intended: lists.intended ?? [],
  } satisfies FindingsFile;
}
