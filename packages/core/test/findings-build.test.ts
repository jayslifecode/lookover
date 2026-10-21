import { ruleById } from '@jayslifecode/lookover-rules';
import { describe, expect, test } from 'vitest';
import { occurrenceFinding } from '../src/findings/build.js';
import { fixPromptFor } from '../src/findings/fix-prompt.js';
import { findingId } from '../src/findings/id.js';
import { evidenceItem, occurrence } from './fixtures/findings.js';

const RULE = ruleById('observers.console-error');
const KEY = 'Report locale missing for # rows';
const OBSERVED = 'logged "Report locale missing for 3 rows"';
const CREATED_AT = '2026-10-21T12:00:00.000Z';

const FIRST = occurrence('screen-1', null, { route: '/reports', url: 'http://localhost:3123/reports' });
const SECOND = occurrence('screen-2', null, { route: '/billing', url: 'http://localhost:3123/billing' });

describe('occurrenceFinding', () => {
  test('fills a candidate from the rule, the key and the occurrences', () => {
    const evidence = [evidenceItem('abc123')];

    const finding = occurrenceFinding({
      rule: RULE,
      key: KEY,
      occurrences: [FIRST],
      observed: OBSERVED,
      evidence,
      createdAt: CREATED_AT,
    });

    expect(finding).toEqual({
      shape: 'occurrence',
      id: findingId(RULE.id, KEY),
      key: KEY,
      source: 'observers',
      rule: { id: 'observers.console-error', source: 'catalogue' },
      severity: RULE.severity,
      status: 'candidate',
      title: RULE.title,
      expected: RULE.expected,
      observed: OBSERVED,
      whyItMatters: RULE.whyItMatters,
      evidence,
      fixPrompt: fixPromptFor({
        rule: RULE,
        route: '/reports',
        url: 'http://localhost:3123/reports',
        target: null,
        observed: OBSERVED,
        occurrences: [FIRST],
      }),
      createdAt: CREATED_AT,
      occurrences: [FIRST],
    });
  });

  test('leads the fix prompt with the first occurrence and lists them all', () => {
    const { fixPrompt } = occurrenceFinding({
      rule: RULE,
      key: KEY,
      occurrences: [FIRST, SECOND],
      observed: OBSERVED,
      evidence: [],
    });

    expect(fixPrompt.startsWith(`In /reports (http://localhost:3123/reports), ${OBSERVED}.`)).toBe(true);
    expect(fixPrompt).toContain('Occurrences (2):');
    expect(fixPrompt).toContain('/billing page');
    expect(fixPrompt.endsWith('Tell me which file you changed.')).toBe(true);
  });

  test('stamps the time it was built unless it is given one', () => {
    const before = Date.now();

    const { createdAt } = occurrenceFinding({
      rule: RULE,
      key: KEY,
      occurrences: [FIRST],
      observed: OBSERVED,
      evidence: [],
    });

    expect(new Date(createdAt).toISOString()).toBe(createdAt);
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before);
  });

  test('gives the same id for the same rule and key', () => {
    const build = (occurrences: (typeof FIRST)[]) =>
      occurrenceFinding({ rule: RULE, key: KEY, occurrences, observed: OBSERVED, evidence: [] });

    expect(build([FIRST]).id).toBe(build([SECOND]).id);
  });

  test('refuses a finding with no occurrence, since there is no page to lead its fix prompt', () => {
    expect(() =>
      occurrenceFinding({ rule: RULE, key: KEY, occurrences: [], observed: OBSERVED, evidence: [] }),
    ).toThrow(/at least one occurrence/);
  });
});
