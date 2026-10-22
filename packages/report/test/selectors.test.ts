// @vitest-environment node
import type { Finding } from '@jayslifecode/lookover-core';
import { expect, test } from 'vitest';
import { initialState, reduce, withDecisions, withFindingsFile, withPrevious } from '../src/data/reduce';
import {
  confirmedFindings,
  decisionOf,
  drift,
  findingById,
  findingsOnScreen,
  firstCapturedScreen,
  fixFirst,
  groups,
  intendedFindings,
  rejectedFindings,
  scorecard,
} from '../src/data/selectors';
import {
  eventOf,
  findingsFile,
  fixtureEvents,
  fixtureFindings,
  fixturePreviousFindings,
  occurrenceFinding,
  stepFinding,
} from './fixture';

const ids = (findings: readonly { id: string }[]) => findings.map((finding) => finding.id);
const compareKeys = (a = '', b = '') => (a === b ? 0 : a < b ? -1 : 1);

/** The fixture run as the report holds it once it has finished: its events, then its findings file. */
function fixtureState() {
  return withFindingsFile(fixtureEvents().reduce(reduce, initialState()), fixtureFindings());
}

test('groups findings by signature, then component name, then rule id, with the screens they affect', () => {
  const result = groups([
    stepFinding({ id: 'a', signature: 'button.btn.primary', screenId: 's1' }),
    stepFinding({ id: 'b', signature: 'button.btn.primary', screenId: 's2' }),
    stepFinding({ id: 'd', signature: null, componentName: 'StatCard', screenId: 's3' }),
    stepFinding({ id: 'c', signature: 'button.btn.primary', screenId: 's1' }),
    stepFinding({ id: 'e', signature: null, componentName: null, ruleId: 'interaction.focus-visible' }),
    occurrenceFinding({ id: 'f', ruleId: 'observers.console-error', screens: ['s2', 's1', 's2'] }),
  ]);
  expect(
    result.map((group) => ({
      label: group.label,
      ids: ids(group.findings),
      screens: group.screens,
      count: group.count,
    })),
  ).toEqual([
    { label: 'button.btn.primary', ids: ['a', 'b', 'c'], screens: ['s1', 's2'], count: 3 },
    { label: 'StatCard', ids: ['d'], screens: ['s3'], count: 1 },
    { label: 'interaction.focus-visible', ids: ['e'], screens: ['4a17c4d0a2'], count: 1 },
    { label: 'observers.console-error', ids: ['f'], screens: ['s2', 's1'], count: 1 },
  ]);
  expect(new Set(result.map((group) => group.key)).size).toBe(result.length);
});

test('a group takes its severity and its lead from its most severe finding, the first one seen on a tie', () => {
  const [group] = groups([
    stepFinding({ id: 'low', severity: 'low', signature: 'a.link' }),
    stepFinding({ id: 'high-1', severity: 'high', signature: 'a.link' }),
    stepFinding({ id: 'high-2', severity: 'high', signature: 'a.link' }),
  ]);
  expect(group?.severity).toBe('high');
  expect(group?.lead.id).toBe('high-1');
});

test("the fixture run reads as one group per signature, the bench's 24 small targets as two groups", () => {
  const confirmed = confirmedFindings(fixtureState());
  const result = fixFirst(groups(confirmed));
  expect(result.map((group) => [group.severity, group.count, group.screens.length])).toEqual([
    ['high', 1, 1],
    ['high', 1, 1],
    ['high', 1, 1],
    ['medium', 12, 1],
    ['medium', 12, 1],
  ]);
  // The two tie on everything but their signature, so the key decides, whatever order they came in.
  const [links, buttons] = result.slice(3).map((group) => group.key);
  expect(compareKeys(links, buttons)).toBeLessThan(0);
  expect(fixFirst(groups(confirmed.toReversed())).map((group) => group.key)).toEqual(
    result.map((group) => group.key),
  );
});

test('fix-first breaks a tie on every other rule by the group key, so the order is total', () => {
  const tied = (id: string, signature: string) =>
    stepFinding({
      id,
      severity: 'medium',
      signature,
      ruleId: 'interaction.target-size',
      title: 'Same title',
    });
  const forward = fixFirst(groups([tied('b', 'sig-b'), tied('a', 'sig-a'), tied('c', 'sig-c')]));
  const backward = fixFirst(groups([tied('c', 'sig-c'), tied('a', 'sig-a'), tied('b', 'sig-b')]));

  expect(forward.map((group) => group.label)).toEqual(['sig-a', 'sig-b', 'sig-c']);
  expect(backward.map((group) => group.label)).toEqual(['sig-a', 'sig-b', 'sig-c']);
});

test('fix-first orders by severity, then screens affected, then rule id, then title', () => {
  const input = groups([
    stepFinding({ id: 'low', severity: 'low', signature: 'sig-low', screenId: 's1' }),
    stepFinding({
      id: 'mzb',
      severity: 'medium',
      signature: 'sig-mzb',
      ruleId: 'zeta',
      title: 'B',
      screenId: 's1',
    }),
    stepFinding({
      id: 'mza',
      severity: 'medium',
      signature: 'sig-mza',
      ruleId: 'zeta',
      title: 'A',
      screenId: 's1',
    }),
    stepFinding({
      id: 'ma',
      severity: 'medium',
      signature: 'sig-ma',
      ruleId: 'alpha',
      title: 'Z',
      screenId: 's1',
    }),
    stepFinding({
      id: 'mw1',
      severity: 'medium',
      signature: 'sig-wide',
      ruleId: 'zeta',
      title: 'Z',
      screenId: 's1',
    }),
    stepFinding({
      id: 'mw2',
      severity: 'medium',
      signature: 'sig-wide',
      ruleId: 'zeta',
      title: 'Z',
      screenId: 's2',
    }),
    stepFinding({ id: 'high', severity: 'high', signature: 'sig-high', screenId: 's1' }),
    stepFinding({ id: 'blocker', severity: 'blocker', signature: 'sig-blocker', screenId: 's1' }),
  ]);
  const before = input.map((group) => group.label);

  expect(fixFirst(input).map((group) => group.label)).toEqual([
    'sig-blocker',
    'sig-high',
    'sig-wide',
    'sig-ma',
    'sig-mza',
    'sig-mzb',
    'sig-low',
  ]);
  expect(input.map((group) => group.label)).toEqual(before);
});

test('confirmed findings leave out candidates, rejected and intended ones; a screen has its step and occurrence findings', () => {
  const state = withFindingsFile(
    initialState(),
    findingsFile({
      findings: [
        stepFinding({ id: 'a', screenId: 's1' }),
        stepFinding({ id: 'b', screenId: 's2' }),
        occurrenceFinding({ id: 'c', screens: ['s2', 's1'] }),
        stepFinding({ id: 'unjudged', screenId: 's1', status: 'candidate' }),
      ],
      rejected: [stepFinding({ id: 'r', screenId: 's1', status: 'rejected' })],
      intended: [stepFinding({ id: 'i', screenId: 's1', status: 'intended' })],
    }),
  );
  expect(ids(confirmedFindings(state))).toEqual(['a', 'b', 'c']);
  expect(ids(findingsOnScreen(state, 's1'))).toEqual(['a', 'c']);
  expect(ids(findingsOnScreen(state, 's2'))).toEqual(['b', 'c']);
  expect(findingsOnScreen(state, 's3')).toEqual([]);
});

test("the user's decisions win once they are loaded: a decided finding is intended, an undecided one is not", () => {
  const file = findingsFile({
    findings: [stepFinding({ id: 'a' }), stepFinding({ id: 'b' })],
    rejected: [stepFinding({ id: 'r', status: 'rejected' })],
    intended: [stepFinding({ id: 'i', status: 'intended' })],
  });
  const unloaded = withFindingsFile(initialState(), file);
  // Until the decisions are in, the findings file says.
  expect(ids(confirmedFindings(unloaded))).toEqual(['a', 'b']);
  expect(ids(intendedFindings(unloaded))).toEqual(['i']);
  expect(ids(rejectedFindings(unloaded))).toEqual(['r']);
  expect(decisionOf(unloaded, file.intended[0] as Finding)?.note).toBe(
    file.intended[0]?.judgement?.note ?? null,
  );

  const decided = withDecisions(unloaded, {
    version: 1,
    decisions: { b: { status: 'intended', at: '2026-10-22T13:00:00.000Z', note: 'On purpose' } },
  });
  expect(ids(confirmedFindings(decided))).toEqual(['a']);
  expect(ids(intendedFindings(decided))).toEqual(['b']);
  expect(decisionOf(decided, file.findings[1] as Finding)).toEqual({
    status: 'intended',
    at: '2026-10-22T13:00:00.000Z',
    note: 'On purpose',
  });
  // `i` was taken back: it is neither confirmed (it was never reproduced) nor intended any more.
  expect(decisionOf(decided, file.intended[0] as Finding)).toBeNull();
  expect(ids(rejectedFindings(decided))).toEqual(['r']);
  // Both are high findings of the fixture's dashboard; the decided one leaves its scorecard.
  expect(scorecard(unloaded, '4a17c4d0a2').confirmed.high).toBe(2);
  expect(scorecard(decided, '4a17c4d0a2').confirmed.high).toBe(1);
});

test('a finding is found by id among the judged, the candidates and the worth-a-look entries', () => {
  const state = withFindingsFile(initialState(), {
    ...findingsFile({
      findings: [stepFinding({ id: 'a' })],
      rejected: [stepFinding({ id: 'r', status: 'rejected' })],
    }),
    worthALook: [stepFinding({ id: 'w', status: 'candidate' })],
  });
  expect(findingById(state, 'a')?.id).toBe('a');
  expect(findingById(state, 'r')?.id).toBe('r');
  expect(findingById(state, 'w')?.id).toBe('w');
  expect(findingById(state, 'nope')).toBeNull();
});

test("a screen's scorecard counts its confirmed findings by severity, its skips and what reproduced every time", () => {
  const state = fixtureState();
  expect(scorecard(state, '4a17c4d0a2')).toEqual({
    confirmed: { blocker: 0, high: 2, medium: 0, low: 0 },
    worthALook: 0,
    rejected: 0,
    reproducedEveryTime: 2,
    skipped: [{ reason: 'text-colour-uncertain:descendant', count: 2 }],
  });
  expect(scorecard(state, '38a8049145').confirmed).toEqual({ blocker: 0, high: 1, medium: 24, low: 0 });
  expect(scorecard(state, '57682dba9d').skipped).toEqual([]);
});

test("a screen's skips are added up per reason, the most frequent first, then by reason", () => {
  // As screen.inspected logs them: each lens's skips in the order it met them, one lens after another.
  const skipped = [
    { reason: 'gone', count: 1 },
    { reason: 'time-budget', count: 3 },
    { reason: 'disabled', count: 2 },
    { reason: 'gone', count: 4 },
    { reason: 'background-uncertain', count: 3 },
  ];
  const inspected = eventOf(
    {
      type: 'screen.inspected',
      screenId: 's1',
      durationMs: 10,
      candidates: 0,
      worthALook: 0,
      skipped,
      gallery: null,
      error: null,
    },
    1,
  );

  expect(scorecard(reduce(initialState(), inspected), 's1').skipped).toEqual([
    { reason: 'gone', count: 5 },
    { reason: 'background-uncertain', count: 3 },
    { reason: 'time-budget', count: 3 },
    { reason: 'disabled', count: 2 },
  ]);
});

test('drift compares the confirmed findings with the previous run; an intended finding is not fixed', () => {
  const state = fixtureState();
  expect(drift(state)).toBeNull();
  expect(firstCapturedScreen(state)?.id).toBe('4a17c4d0a2');

  const previous = fixturePreviousFindings();
  const gone = stepFinding({ id: 'gone' });
  const result = drift(withPrevious(state, { ...previous, findings: [...previous.findings, gone] }));

  expect(result?.added).toHaveLength(25);
  expect(ids(result?.unchanged ?? [])).toEqual(['fc8addc0486b', 'da77d007d373']);
  expect(ids(result?.fixed ?? [])).toEqual(['gone']);
});
