import { describe, expect, test } from 'vitest';
import { findingId, mergeFindings } from '../src/findings/id.js';
import type { Finding } from '../src/findings/types.js';
import {
  deepFreeze,
  evidenceItem,
  MOBILE,
  occurrence,
  occurrenceFinding,
  stepFinding,
} from './fixtures/findings.js';

describe('findingId', () => {
  test('findingId is stable and 12 hex characters', () => {
    expect(findingId('a.b', 'k')).toBe(findingId('a.b', 'k'));
    expect(findingId('a.b', 'k')).toMatch(/^[0-9a-f]{12}$/);
    expect(findingId('a.b', 'k')).not.toBe(findingId('a.b', 'k2'));
  });

  test('the same key under another rule is another finding', () => {
    expect(findingId('a.b', 'k')).not.toBe(findingId('a.c', 'k'));
  });
});

describe('mergeFindings', () => {
  test('mergeFindings unions occurrences and evidence of the same id, keeps order, mutates nothing', () => {
    const first = occurrenceFinding({
      id: 'f1',
      occurrences: [occurrence('s1', '#a'), occurrence('s2', '#b')],
      evidence: [evidenceItem('e1'), evidenceItem('e2')],
    });
    const middle = stepFinding({ id: 'f2' });
    const last = occurrenceFinding({
      id: 'f1',
      occurrences: [occurrence('s2', '#b'), occurrence('s3', '#c')],
      evidence: [evidenceItem('e2'), evidenceItem('e3')],
    });
    const input: Finding[] = deepFreeze([first, middle, last]);
    const before = structuredClone(input);

    const merged = mergeFindings(input);

    expect(merged.map((finding) => finding.id)).toEqual(['f1', 'f2']);
    const [union] = merged;
    expect(union?.shape).toBe('occurrence');
    if (union?.shape !== 'occurrence') return;
    expect(union.occurrences.map(({ screenId, selector }) => `${screenId}|${selector}`)).toEqual([
      's1|#a',
      's2|#b',
      's3|#c',
    ]);
    expect(union.evidence.map((item) => item.ref.id)).toEqual(['e1', 'e2', 'e3']);
    expect(input).toEqual(before);
    expect(union).not.toBe(first);
  });

  test('mergeFindings keeps the first of two step findings with one id', () => {
    const first = stepFinding({ id: 'same', title: 'first', evidence: [evidenceItem('e1')] });
    const second = stepFinding({ id: 'same', title: 'second', evidence: [evidenceItem('e2')] });

    const merged = mergeFindings(deepFreeze([first, second]));

    expect(merged).toEqual([first]);
  });

  test('keeps the first when a step finding and an occurrence finding share an id', () => {
    const step = stepFinding({ id: 'same' });
    const grouped = occurrenceFinding({ id: 'same', occurrences: [occurrence('s1', '#a')] });

    expect(mergeFindings([step, grouped])).toEqual([step]);
    expect(mergeFindings([grouped, step])).toEqual([grouped]);
  });

  test('an occurrence is the same one only on the same screen, selector and viewport name', () => {
    const first = occurrenceFinding({
      id: 'f1',
      occurrences: [occurrence('s1', '#a'), occurrence('s1', null)],
    });
    const second = occurrenceFinding({
      id: 'f1',
      occurrences: [
        occurrence('s1', '#a'),
        occurrence('s1', '#a', { viewport: MOBILE }),
        occurrence('s1', null),
        occurrence('s1', null, { measured: { count: 9 } }),
      ],
    });

    const [merged] = mergeFindings([first, second]);

    expect(merged?.shape === 'occurrence' ? merged.occurrences.map((o) => o.viewport.name) : []).toEqual([
      'desktop',
      'desktop',
      'mobile',
    ]);
    expect(merged?.shape === 'occurrence' ? merged.occurrences.map((o) => o.measured) : []).toEqual([
      { count: 1 },
      { count: 1 },
      { count: 1 },
    ]);
  });

  test('keeps every other field of the first occurrence finding', () => {
    const first = occurrenceFinding({ id: 'f1', observed: 'first observed', occurrences: [] });
    const second = occurrenceFinding({ id: 'f1', observed: 'second observed', occurrences: [] });

    expect(mergeFindings([first, second])).toEqual([first]);
  });

  test('returns an empty list for no findings and leaves distinct ids alone', () => {
    const a = stepFinding({ id: 'a' });
    const b = occurrenceFinding({ id: 'b' });

    expect(mergeFindings([])).toEqual([]);
    expect(mergeFindings([b, a])).toEqual([b, a]);
  });
});
