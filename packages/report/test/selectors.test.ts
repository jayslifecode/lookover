// @vitest-environment node
import { expect, test } from 'vitest';
import { initialState, reduce, withFindingsFile, withPrevious } from '../src/data/reduce';
import {
  confirmedFindings,
  drift,
  findingsOnScreen,
  firstCapturedScreen,
  fixFirst,
  groups,
  scorecard,
} from '../src/data/selectors';
import {
  findingsFile,
  fixtureEvents,
  fixtureFindings,
  fixturePreviousFindings,
  occurrenceFinding,
  stepFinding,
} from './fixture';

const ids = (findings: readonly { id: string }[]) => findings.map((finding) => finding.id);

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
  const result = fixFirst(groups(confirmedFindings(fixtureState())));
  expect(result.map((group) => [group.severity, group.count, group.screens.length])).toEqual([
    ['high', 1, 1],
    ['high', 1, 1],
    ['high', 1, 1],
    ['medium', 12, 1],
    ['medium', 12, 1],
  ]);
  expect(
    result.slice(3).map((group) => (group.lead.shape === 'step' ? group.lead.target?.componentName : null)),
  ).toEqual(['LinkComponent', 'CopyEmailButton']);
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
