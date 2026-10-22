import { ruleById } from '@jayslifecode/lookover-rules';
import { describe, expect, test } from 'vitest';
import { occurrenceFinding, stepFinding } from '../src/findings/build.js';
import { fixPromptFor } from '../src/findings/fix-prompt.js';
import { findingId } from '../src/findings/id.js';
import type { StepTrace } from '../src/findings/types.js';
import { DESKTOP, evidenceItem, occurrence, SAVE_BUTTON } from './fixtures/findings.js';

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
      judgement: null,
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

describe('stepFinding', () => {
  const FOCUS_RULE = ruleById('interaction.focus-visible-missing');
  const OVERFLOW_RULE = ruleById('interaction.horizontal-overflow');
  const FOCUS_OBSERVED = 'shows no change when it receives keyboard focus';
  const SCREEN = { id: 'screen-7', route: '/settings', url: 'http://localhost:3123/settings' };
  const TRACE: StepTrace = {
    route: SCREEN.route,
    url: SCREEN.url,
    viewport: DESKTOP,
    steps: [
      { kind: 'navigate', url: SCREEN.url },
      { kind: 'set-viewport', viewport: DESKTOP },
      { kind: 'force-state', selector: SAVE_BUTTON.selector, state: 'focus' },
      { kind: 'measure', what: 'computed styles before and after focus' },
    ],
  };

  function build(overrides: Partial<Parameters<typeof stepFinding>[0]> = {}) {
    return stepFinding({
      rule: FOCUS_RULE,
      screen: SCREEN,
      target: SAVE_BUTTON,
      trace: TRACE,
      observed: FOCUS_OBSERVED,
      evidence: [],
      ...overrides,
    });
  }

  test('fills a candidate from the rule, the screen, the target and the trace', () => {
    const evidence = [evidenceItem('def456')];
    const key = '/settings|button[type="submit"]';

    const finding = build({ evidence, createdAt: CREATED_AT });

    expect(finding).toEqual({
      shape: 'step',
      id: findingId(FOCUS_RULE.id, key),
      key,
      source: 'interaction',
      rule: { id: 'interaction.focus-visible-missing', source: 'catalogue' },
      severity: FOCUS_RULE.severity,
      status: 'candidate',
      judgement: null,
      title: FOCUS_RULE.title,
      expected: FOCUS_RULE.expected,
      observed: FOCUS_OBSERVED,
      whyItMatters: FOCUS_RULE.whyItMatters,
      evidence,
      fixPrompt: fixPromptFor({
        rule: FOCUS_RULE,
        route: '/settings',
        url: 'http://localhost:3123/settings',
        target: SAVE_BUTTON,
        observed: FOCUS_OBSERVED,
      }),
      createdAt: CREATED_AT,
      screenId: 'screen-7',
      target: SAVE_BUTTON,
      trace: TRACE,
    });
  });

  test('leads the fix prompt with the screen and names the element', () => {
    const { fixPrompt } = build();

    expect(fixPrompt.split('\n')[0]).toBe(
      'In /settings (http://localhost:3123/settings), the button "Save" (selector `button[type="submit"]`, ' +
        `React component SettingsForm) ${FOCUS_OBSERVED}.`,
    );
    expect(
      fixPrompt.endsWith("Keep the control's accessible name, then tell me which file you changed."),
    ).toBe(true);
  });

  test('adds the suffix to the key of a viewport-specific rule', () => {
    const key = '/settings|button[type="submit"]|mobile';

    const finding = build({ rule: OVERFLOW_RULE, keySuffix: 'mobile' });

    expect(finding.key).toBe(key);
    expect(finding.id).toBe(findingId(OVERFLOW_RULE.id, key));
  });

  test('gives the same id for the same rule, route and selector on another screen', () => {
    const other = build({
      screen: { ...SCREEN, id: 'screen-9', url: 'http://localhost:3123/settings?tab=2' },
    });

    expect(other.id).toBe(build().id);
    expect(build({ rule: OVERFLOW_RULE }).id).not.toBe(build().id);
  });

  test('stamps the time it was built unless it is given one', () => {
    const before = Date.now();

    const { createdAt } = build();

    expect(new Date(createdAt).toISOString()).toBe(createdAt);
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before);
  });
});
