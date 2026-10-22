import {
  type Attempt,
  mergeFindings,
  type Occurrence,
  type OccurrenceFinding,
  withRebuiltFixPrompt,
} from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import {
  decideOccurrence,
  decideStep,
  MAX_NOTE_CHARS,
  type ModelVerdict,
  modelUnavailableNote,
  targetKey,
} from '../src/index.js';
import { ENVIRONMENT, VIEWPORT } from './helpers/bundle-fixtures.js';
import { attemptsAt, errorOn, focusOn, NOW, screenAt } from './helpers/pipeline-bed.js';

const OPTIONS = { judgedAt: NOW };
const SETTINGS = screenAt('screen-settings', '/settings');
const HOME = screenAt('screen-home', '/');
const REPORTS = screenAt('screen-reports', '/reports');
const CONFIRMED_BY_MODEL: ModelVerdict = {
  verdict: {
    verdict: 'confirm',
    attribution: 'product-defect',
    oracle: 'WCAG 2.2 2.4.7 Focus Visible',
    note: 'The Save button shows no outline when it is reached with the keyboard.',
  },
  model: 'claude-sonnet-5-5',
  usage: { input: 1_200, output: 60, cacheRead: 900, cacheWrite: 0 },
  estimatedUsd: 0.00318,
  cached: false,
};

/** The console error seen on the home page and on the reports page, merged as the run merges it. */
function errorOnBoth(): OccurrenceFinding {
  const [merged] = mergeFindings([
    errorOn('Failed to load the chart', [HOME]),
    errorOn('Failed to load the chart', [REPORTS]),
  ]);
  if (merged?.shape !== 'occurrence') throw new Error('the two errors did not merge');
  return merged;
}

/** Each occurrence's attempts, the occurrence on `screenId` reproducing `reproduced[screenId]` times. */
function attemptsByOccurrence(
  finding: OccurrenceFinding,
  reproduced: Readonly<Record<string, number>>,
): Map<string, Attempt[]> {
  return new Map(
    finding.occurrences.flatMap((occurrence: Occurrence) => {
      const times = reproduced[occurrence.screenId];
      if (times === undefined) return [];
      const target = { finding, occurrence };
      return [[targetKey(target), attemptsAt(target, times)] as const];
    }),
  );
}

/** Freezes `value` and everything inside it, so a function that changes its input throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    const children = value instanceof Map ? [...value.values()] : Object.values(value);
    for (const child of children) deepFreeze(child);
  }
  return value;
}

describe('decideStep', () => {
  test('a finding reproduced 3 of 3 times with no model verdict is confirmed by the harness as a product defect', () => {
    const finding = focusOn(SETTINGS);
    const attempts = attemptsAt({ finding }, 3);

    const decided = decideStep(finding, attempts, null, ENVIRONMENT, OPTIONS);

    expect(decided).toEqual({
      ...finding,
      status: 'confirmed',
      judgement: {
        reproduced: 3,
        of: 3,
        attempts,
        decidedBy: 'harness',
        attribution: 'product-defect',
        oracle: null,
        note: null,
        model: null,
        usage: null,
        estimatedUsd: null,
        cached: false,
        droppedOccurrences: [],
        environment: ENVIRONMENT,
        judgedAt: NOW,
      },
    });
  });

  test('fewer than 3 reproductions are rejected as timing, whatever the model said', () => {
    const finding = focusOn(SETTINGS);

    const decided = decideStep(finding, attemptsAt({ finding }, 1), CONFIRMED_BY_MODEL, ENVIRONMENT, OPTIONS);

    expect(decided.status).toBe('rejected');
    expect(decided.judgement).toMatchObject({
      reproduced: 1,
      of: 3,
      decidedBy: 'harness',
      attribution: 'timing',
      oracle: null,
      note: 'Reproduced 1 of 3 times; a problem that comes and goes is not reported',
      model: null,
      usage: null,
    });
  });

  test('a model verdict on a reproduced finding is taken with its oracle, note, usage and cost', () => {
    const finding = focusOn(SETTINGS);

    const decided = decideStep(finding, attemptsAt({ finding }, 3), CONFIRMED_BY_MODEL, ENVIRONMENT, OPTIONS);

    expect(decided.status).toBe('confirmed');
    expect(decided.judgement).toMatchObject({
      reproduced: 3,
      decidedBy: 'model',
      attribution: 'product-defect',
      oracle: CONFIRMED_BY_MODEL.verdict.oracle,
      note: CONFIRMED_BY_MODEL.verdict.note,
      model: 'claude-sonnet-5-5',
      usage: CONFIRMED_BY_MODEL.usage,
      estimatedUsd: CONFIRMED_BY_MODEL.estimatedUsd,
      cached: false,
    });
  });

  test('a harness confirmation carries why the model was not asked, cut to the note limit', () => {
    const finding = focusOn(SETTINGS);
    const reason = `The judge model call failed: 529 ${'Overloaded '.repeat(40)}`;

    const decided = decideStep(finding, attemptsAt({ finding }, 3), null, ENVIRONMENT, {
      ...OPTIONS,
      harnessNote: modelUnavailableNote(reason),
    });

    expect(decided.judgement).toMatchObject({ decidedBy: 'harness', attribution: 'product-defect' });
    expect(decided.judgement?.note).toMatch(
      /^The judge model was unavailable \(The judge model call failed: 529/,
    );
    expect(Array.from(decided.judgement?.note ?? '').length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
  });
});

describe('decideOccurrence', () => {
  test('keeps the occurrences that reproduced 3 of 3 times, drops the rest and rebuilds the fix prompt', () => {
    const finding = errorOnBoth();
    const attempts = attemptsByOccurrence(finding, { [HOME.id]: 3, [REPORTS.id]: 2 });
    const [onHome, onReports] = finding.occurrences;

    const decided = decideOccurrence(finding, attempts, null, ENVIRONMENT, OPTIONS);

    expect(decided.status).toBe('confirmed');
    expect(decided.occurrences).toEqual([onHome]);
    expect(decided.fixPrompt).toBe(
      withRebuiltFixPrompt({ ...finding, occurrences: [onHome as Occurrence] }).fixPrompt,
    );
    expect(decided.fixPrompt).not.toBe(finding.fixPrompt);
    expect(decided.judgement).toMatchObject({
      reproduced: 1,
      of: 2,
      decidedBy: 'harness',
      attribution: 'product-defect',
      droppedOccurrences: [onReports],
    });
    // Every attempt is kept on the record, occurrence by occurrence.
    expect(decided.judgement?.attempts.map(({ occurrence }) => occurrence?.screenId)).toEqual([
      HOME.id,
      HOME.id,
      HOME.id,
      REPORTS.id,
      REPORTS.id,
      REPORTS.id,
    ]);
  });

  test('is rejected as timing, keeping where it was seen, when no occurrence reproduced every time', () => {
    const finding = errorOnBoth();

    const decided = decideOccurrence(
      finding,
      attemptsByOccurrence(finding, { [HOME.id]: 2, [REPORTS.id]: 1 }),
      CONFIRMED_BY_MODEL,
      ENVIRONMENT,
      OPTIONS,
    );

    expect(decided).toMatchObject({
      status: 'rejected',
      occurrences: finding.occurrences,
      fixPrompt: finding.fixPrompt,
    });
    expect(decided.judgement).toMatchObject({
      reproduced: 0,
      of: 2,
      decidedBy: 'harness',
      attribution: 'timing',
      note: 'Reproduced 2 of 3 times; a problem that comes and goes is not reported',
      model: null,
      droppedOccurrences: finding.occurrences,
    });
  });

  test('a finding every occurrence of which reproduced keeps its occurrences and its fix prompt', () => {
    const finding = errorOnBoth();

    const decided = decideOccurrence(
      finding,
      attemptsByOccurrence(finding, { [HOME.id]: 3, [REPORTS.id]: 3 }),
      CONFIRMED_BY_MODEL,
      ENVIRONMENT,
      OPTIONS,
    );

    expect(decided).toMatchObject({
      status: 'confirmed',
      occurrences: finding.occurrences,
      fixPrompt: finding.fixPrompt,
    });
    expect(decided.judgement).toMatchObject({
      reproduced: 2,
      of: 2,
      decidedBy: 'model',
      droppedOccurrences: [],
    });
  });

  test('an occurrence the harness has no attempts for is dropped', () => {
    const finding = errorOnBoth();

    const decided = decideOccurrence(
      finding,
      attemptsByOccurrence(finding, { [HOME.id]: 3 }),
      null,
      ENVIRONMENT,
      OPTIONS,
    );

    expect(decided.occurrences.map(({ screenId }) => screenId)).toEqual([HOME.id]);
    expect(decided.judgement?.droppedOccurrences.map(({ screenId }) => screenId)).toEqual([REPORTS.id]);
    expect(decided.judgement?.attempts).toHaveLength(3);
  });
});

test('deciding leaves its inputs untouched', () => {
  const step = deepFreeze(focusOn(SETTINGS));
  const occurrence = deepFreeze(errorOnBoth());
  const stepAttempts = deepFreeze(attemptsAt({ finding: step }, 3));
  const occurrenceAttempts = deepFreeze(attemptsByOccurrence(occurrence, { [HOME.id]: 3, [REPORTS.id]: 1 }));
  const environment = deepFreeze({ ...ENVIRONMENT, viewport: { ...VIEWPORT } });

  expect(() => decideStep(step, stepAttempts, CONFIRMED_BY_MODEL, environment, OPTIONS)).not.toThrow();
  expect(() => decideOccurrence(occurrence, occurrenceAttempts, null, environment, OPTIONS)).not.toThrow();
});
