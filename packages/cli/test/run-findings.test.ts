import type { OccurrenceFinding } from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import {
  candidateLines,
  findingLines,
  groupCandidates,
  groupConfirmed,
} from '../src/commands/run-findings.js';
import { findingsFile, judged, judgedFile, occurrenceCandidate, stepCandidate } from './run-fixtures.js';

describe('groupConfirmed', () => {
  test('groups the confirmed findings by rule, with how often the first was reproduced', () => {
    const groups = groupConfirmed(
      judgedFile({
        findings: [
          judged(stepCandidate({ ruleId: 'interaction.focus-visible-missing', selector: '#a' })),
          judged(stepCandidate({ ruleId: 'interaction.focus-visible-missing', selector: '#b' })),
          judged(occurrenceCandidate('observers.console-error', ['a', 'b'])),
        ],
      }),
    );

    expect(groups.map(({ ruleId, count, attempts }) => ({ ruleId, count, attempts }))).toEqual([
      { ruleId: 'interaction.focus-visible-missing', count: 2, attempts: { reproduced: 3, of: 3 } },
      { ruleId: 'observers.console-error', count: 1, attempts: { reproduced: 3, of: 3 } },
    ]);
  });

  test('counts the attempts of the first kept occurrence, not the occurrences', () => {
    const finding = judged(occurrenceCandidate('observers.console-error', ['a', 'b', 'c', 'd']));

    const [group] = groupConfirmed(judgedFile({ findings: [finding] }));

    expect((finding as OccurrenceFinding).judgement?.of).toBe(4);
    expect(group?.attempts).toEqual({ reproduced: 3, of: 3 });
  });

  test('leaves out a candidate the judge never decided on', () => {
    const groups = groupConfirmed(
      judgedFile({
        findings: [
          judged(stepCandidate({ ruleId: 'interaction.target-size' })),
          stepCandidate({ ruleId: 'interaction.focus-visible-missing' }),
        ],
      }),
    );

    expect(groups.map((group) => group.ruleId)).toEqual(['interaction.target-size']);
  });

  test('leaves out the rejected and intended findings and the worth-a-look entries', () => {
    const groups = groupConfirmed(
      judgedFile({
        rejected: [judged(stepCandidate({ ruleId: 'interaction.target-size' }), { status: 'rejected' })],
        intended: [{ ...stepCandidate({ ruleId: 'interaction.focus-hidden' }), status: 'intended' }],
        worthALook: [stepCandidate({ ruleId: 'interaction.hover-state-missing', severity: 'low' })],
      }),
    );

    expect(groups).toEqual([]);
  });
});

describe('findingLines', () => {
  test('lists the confirmed findings of a judged run, each line ending with its reproductions', () => {
    const lines = findingLines(
      judgedFile({
        findings: [
          judged(stepCandidate({ ruleId: 'interaction.focus-visible-missing', route: '/settings' })),
          judged(occurrenceCandidate('observers.console-error', ['a', 'b'])),
        ],
        rejected: [judged(stepCandidate({ ruleId: 'interaction.target-size' }), { status: 'rejected' })],
      }),
    );

    expect(lines).toEqual([
      '  high    interaction.focus-visible-missing  1  /settings button "Save"     reproduced 3/3',
      '  medium  observers.console-error            1  2 occurrences on 2 screens  reproduced 3/3',
    ]);
  });

  test('lists the candidates of a run that was not judged, as they were measured', () => {
    const lines = findingLines(
      findingsFile([stepCandidate({ ruleId: 'interaction.focus-visible-missing', route: '/settings' })]),
    );

    expect(lines).toEqual(['  high  interaction.focus-visible-missing  1  /settings button "Save"']);
  });

  test('is empty when a judged run confirmed nothing', () => {
    const rejected = [judged(stepCandidate({ ruleId: 'interaction.target-size' }), { status: 'rejected' })];

    expect(findingLines(judgedFile({ rejected }))).toEqual([]);
  });
});

describe('groupCandidates', () => {
  test('is empty when there are no candidates', () => {
    expect(groupCandidates(findingsFile([]))).toEqual([]);
  });

  test('groups candidates by rule, with the count, the rule title and the severity', () => {
    const groups = groupCandidates(
      findingsFile([
        stepCandidate({ ruleId: 'interaction.focus-visible-missing', selector: '#a' }),
        stepCandidate({ ruleId: 'interaction.focus-visible-missing', selector: '#b' }),
        stepCandidate({ ruleId: 'interaction.target-size', severity: 'medium' }),
      ]),
    );

    expect(groups).toEqual([
      {
        severity: 'high',
        ruleId: 'interaction.focus-visible-missing',
        title: 'Title of interaction.focus-visible-missing',
        count: 2,
        example: '/ button "Save"',
      },
      {
        severity: 'medium',
        ruleId: 'interaction.target-size',
        title: 'Title of interaction.target-size',
        count: 1,
        example: '/ button "Save"',
      },
    ]);
  });

  test('sorts from blocker to low, then by count (most first), then by rule id', () => {
    const groups = groupCandidates(
      findingsFile([
        stepCandidate({ ruleId: 'interaction.low-rule', severity: 'low' }),
        stepCandidate({ ruleId: 'interaction.b-rule', severity: 'medium' }),
        stepCandidate({ ruleId: 'interaction.a-rule', severity: 'medium' }),
        stepCandidate({ ruleId: 'interaction.many', severity: 'medium', selector: '#1' }),
        stepCandidate({ ruleId: 'interaction.many', severity: 'medium', selector: '#2' }),
        stepCandidate({ ruleId: 'interaction.blocking', severity: 'blocker' }),
        stepCandidate({ ruleId: 'interaction.high-rule', severity: 'high' }),
      ]),
    );

    expect(groups.map((group) => group.ruleId)).toEqual([
      'interaction.blocking',
      'interaction.high-rule',
      'interaction.many',
      'interaction.a-rule',
      'interaction.b-rule',
      'interaction.low-rule',
    ]);
  });

  test('shows the route, role and name of the first step finding as the example', () => {
    const [group] = groupCandidates(
      findingsFile([
        stepCandidate({
          ruleId: 'interaction.focus-visible-missing',
          route: '/settings',
          role: 'button',
          name: 'Save',
        }),
        stepCandidate({
          ruleId: 'interaction.focus-visible-missing',
          route: '/login',
          role: 'link',
          name: 'Help',
        }),
      ]),
    );

    expect(group?.example).toBe('/settings button "Save"');
  });

  test('shows only the route for a step finding without an element', () => {
    const [group] = groupCandidates(
      findingsFile([
        stepCandidate({ ruleId: 'interaction.horizontal-overflow', route: '/organisations', target: null }),
      ]),
    );

    expect(group?.example).toBe('/organisations');
  });

  test('counts the occurrences and the screens of an occurrence finding as the example', () => {
    const groups = groupCandidates(
      findingsFile([
        occurrenceCandidate('observers.console-error', ['a', 'a', 'b']),
        occurrenceCandidate('observers.raw-value', ['c'], 'high'),
      ]),
    );

    expect(groups.map((group) => [group.ruleId, group.example])).toEqual([
      ['observers.raw-value', '1 occurrence on 1 screen'],
      ['observers.console-error', '3 occurrences on 2 screens'],
    ]);
  });

  test('replaces control characters in an element name, so a page cannot write to the terminal', () => {
    const [group] = groupCandidates(
      findingsFile([stepCandidate({ ruleId: 'interaction.target-size', name: 'Save\u001b[2J\nnow' })]),
    );

    expect(group?.example).toBe('/ button "Save [2J now"');
  });

  test.each([
    ['a bidi override', 'Pay\u202Egnp.exe', 'Pay gnp.exe'],
    ['a line separator', 'Save\u2028now', 'Save now'],
    ['a paragraph separator', 'Save\u2029now', 'Save now'],
  ])(
    'replaces %s in an element name, so the name cannot be shown reversed or split',
    (_what, name, shown) => {
      const [group] = groupCandidates(
        findingsFile([stepCandidate({ ruleId: 'interaction.target-size', name })]),
      );

      expect(group?.example).toBe(`/ button "${shown}"`);
    },
  );

  test.each([
    // A family emoji: four people joined by U+200D (zero width joiner).
    ['an emoji joined with a zero width joiner', 'Share with \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'],
    // "می‌خواهم" (I want): Persian writes U+200C (zero width non-joiner) inside the word.
    ['a Persian word with a zero width non-joiner', 'Save می‌خواهم'],
  ])('keeps %s in an element name unchanged', (_what, name) => {
    const [group] = groupCandidates(
      findingsFile([stepCandidate({ ruleId: 'interaction.target-size', name })]),
    );

    expect(group?.example).toBe(`/ button "${name}"`);
  });

  test('leaves the worth-a-look entries out', () => {
    const groups = groupCandidates(
      findingsFile([], [stepCandidate({ ruleId: 'interaction.hover-state-missing', severity: 'low' })]),
    );

    expect(groups).toEqual([]);
  });

  test('does not change the findings file', () => {
    const input = findingsFile([
      stepCandidate({ ruleId: 'interaction.target-size', severity: 'medium' }),
      stepCandidate({ ruleId: 'interaction.focus-visible-missing' }),
    ]);
    const snapshot = structuredClone(input);

    groupCandidates(input);

    expect(input).toEqual(snapshot);
  });
});

describe('candidateLines', () => {
  test('is empty for no groups', () => {
    expect(candidateLines([])).toEqual([]);
  });

  test('prints one line per group, with severity, rule, count and example in aligned columns', () => {
    const lines = candidateLines(
      groupCandidates(
        findingsFile([
          stepCandidate({ ruleId: 'interaction.focus-visible-missing', route: '/settings', name: 'Save' }),
          stepCandidate({
            ruleId: 'interaction.focus-visible-missing',
            route: '/login',
            name: 'Go',
            selector: '#go',
          }),
          stepCandidate({
            ruleId: 'interaction.target-size',
            severity: 'medium',
            route: '/organisations',
            role: 'link',
            name: 'Edit',
          }),
        ]),
      ),
    );

    expect(lines).toEqual([
      '  high    interaction.focus-visible-missing  2  /settings button "Save"',
      '  medium  interaction.target-size            1  /organisations link "Edit"',
    ]);
  });

  test('widens the columns to the longest severity and the largest count', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      stepCandidate({ ruleId: 'interaction.target-size', severity: 'low', selector: `#t${index}` }),
    );
    const lines = candidateLines(
      groupCandidates(
        findingsFile([
          stepCandidate({ ruleId: 'interaction.keyboard-unreachable', severity: 'blocker' }),
          ...many,
        ]),
      ),
    );

    expect(lines).toEqual([
      '  blocker  interaction.keyboard-unreachable   1  / button "Save"',
      '  low      interaction.target-size           12  / button "Save"',
    ]);
  });
});
