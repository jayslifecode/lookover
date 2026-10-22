import { describe, expect, test } from 'vitest';
import { diffFindings } from '../src/findings/diff.js';
import type { Finding, FindingsFile } from '../src/findings/types.js';
import { deepFreeze, findingsFile, occurrenceFinding, stepFinding } from './fixtures/findings.js';

function fileOf(findings: Finding[], runId: string, worthALook: Finding[] = []): FindingsFile {
  return findingsFile({ runId, findings, worthALook });
}

describe('diffFindings', () => {
  const a = stepFinding({ id: 'a' });
  const b = occurrenceFinding({ id: 'b' });
  const c = stepFinding({ id: 'c' });

  test('sorts the findings into added, fixed and unchanged by id', () => {
    const previous = fileOf([a, b], 'run-1');
    const current = fileOf([b, c], 'run-2');

    const drift = diffFindings(previous, current);

    expect(drift.added.map((finding) => finding.id)).toEqual(['c']);
    expect(drift.fixed.map((finding) => finding.id)).toEqual(['a']);
    expect(drift.unchanged.map((finding) => finding.id)).toEqual(['b']);
  });

  test('takes added and unchanged from the current file and fixed from the previous one', () => {
    const olderB = { ...b, observed: 'the earlier wording' };
    const previous = fileOf([a, olderB], 'run-1');
    const current = fileOf([b, c], 'run-2');

    const drift = diffFindings(previous, current);

    expect(drift.unchanged).toEqual([b]);
    expect(drift.fixed).toEqual([a]);
    expect(drift.added).toEqual([c]);
  });

  test('makes everything added when there is no previous file', () => {
    const drift = diffFindings(null, fileOf([a, b], 'run-1'));

    expect(drift).toEqual({ added: [a, b], fixed: [], unchanged: [] });
  });

  test('makes everything fixed when nothing is found any more', () => {
    const drift = diffFindings(fileOf([a, b], 'run-1'), fileOf([], 'run-2'));

    expect(drift).toEqual({ added: [], fixed: [a, b], unchanged: [] });
  });

  test('is empty when both runs found nothing', () => {
    expect(diffFindings(fileOf([], 'run-1'), fileOf([], 'run-2'))).toEqual({
      added: [],
      fixed: [],
      unchanged: [],
    });
  });

  test('looks at the findings lists only, never at worthALook, rejected or intended', () => {
    const previous = findingsFile({
      runId: 'run-1',
      findings: [],
      worthALook: [a],
      rejected: [b],
      intended: [c],
    });
    const current = findingsFile({
      runId: 'run-2',
      findings: [a],
      worthALook: [],
      rejected: [],
      intended: [],
    });

    const drift = diffFindings(previous, current);

    expect(drift).toEqual({ added: [a], fixed: [], unchanged: [] });
  });

  test('keeps the order of each list', () => {
    const drift = diffFindings(fileOf([c, a], 'run-1'), fileOf([b, a, c], 'run-2'));

    expect(drift.unchanged.map((finding) => finding.id)).toEqual(['a', 'c']);
    expect(drift.added.map((finding) => finding.id)).toEqual(['b']);
  });

  test('does not modify its inputs', () => {
    const previous = deepFreeze(fileOf([a, b], 'run-1'));
    const current = deepFreeze(fileOf([b, c], 'run-2'));

    expect(() => diffFindings(previous, current)).not.toThrow();
  });
});
