import { ruleById } from '@jayslifecode/lookover-rules';
import { describe, expect, test } from 'vitest';
import { fixPromptFor } from '../src/findings/fix-prompt.js';
import { occurrence, SAVE_BUTTON } from './fixtures/findings.js';

const ROUTE = '/settings';
const URL = 'http://localhost:3123/settings';
const CLOSING_LINE = "Keep the control's accessible name, then tell me which file you changed.";
const NO_TARGET_CLOSING_LINE = 'Tell me which file you changed.';

describe('fixPromptFor', () => {
  const focusRule = ruleById('interaction.focus-visible-missing');
  const unreferencedRule = ruleById('interaction.hover-state-missing');
  const consoleRule = ruleById('observers.console-error');

  test('fixPromptFor renders the target line, the rule lines and the reference', () => {
    const rule = focusRule;

    const prompt = fixPromptFor({
      rule,
      route: ROUTE,
      url: URL,
      target: SAVE_BUTTON,
      observed: 'shows no change when it receives keyboard focus',
    });

    expect(prompt).toBe(
      `In /settings (http://localhost:3123/settings), the button "Save" (selector \`button[type="submit"]\`, React component SettingsForm) shows no change when it receives keyboard focus.\nRule: Keyboard focus is not visible. Expected: ${rule.expected} ${rule.whyItMatters}\nFix: ${rule.fixHint} Reference: WCAG 2.2 2.4.7 Focus Visible (https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).\n${CLOSING_LINE}`,
    );
  });

  test('leaves out the React component when the page does not expose one', () => {
    const prompt = fixPromptFor({
      rule: focusRule,
      route: ROUTE,
      url: URL,
      target: { ...SAVE_BUTTON, componentName: null },
      observed: 'shows no change when it receives keyboard focus',
    });

    expect(prompt.split('\n')[0]).toBe(
      'In /settings (http://localhost:3123/settings), the button "Save" (selector `button[type="submit"]`) shows no change when it receives keyboard focus.',
    );
  });

  test('starts with the route and the observation when there is no target', () => {
    const prompt = fixPromptFor({
      rule: focusRule,
      route: ROUTE,
      url: URL,
      target: null,
      observed: 'no control could be reached with the Tab key',
    });

    const lines = prompt.split('\n');
    expect(lines[0]).toBe(
      'In /settings (http://localhost:3123/settings), no control could be reached with the Tab key.',
    );
    expect(lines.at(-1)).toBe(NO_TARGET_CLOSING_LINE);
    expect(prompt).not.toContain('accessible name');
  });

  test('fixPromptFor omits the reference for a rule without one', () => {
    const rule = unreferencedRule;
    expect(rule.reference).toBeNull();

    const prompt = fixPromptFor({
      rule,
      route: ROUTE,
      url: URL,
      target: SAVE_BUTTON,
      observed: 'looks the same when hovered',
    });

    expect(prompt.split('\n').slice(1)).toEqual([
      `Rule: ${rule.title}. Expected: ${rule.expected} ${rule.whyItMatters}`,
      `Fix: ${rule.fixHint}`,
      CLOSING_LINE,
    ]);
  });

  test('lists each occurrence on its own line, with the page when there is no selector', () => {
    expect(consoleRule.reference).toBeNull();

    const prompt = fixPromptFor({
      rule: consoleRule,
      route: ROUTE,
      url: URL,
      target: null,
      observed: 'logged "Failed to load resource" 2 times',
      occurrences: [
        occurrence('s1', '#a', { route: '/a', measured: { type: 'error', count: 2, location: null } }),
        occurrence('s2', null, { route: '/b', measured: {} }),
      ],
    });

    expect(prompt.split('\n')).toEqual([
      'In /settings (http://localhost:3123/settings), logged "Failed to load resource" 2 times.',
      'Occurrences (2):',
      '/a #a — type=error, count=2, location=null',
      '/b page',
      `Rule: ${consoleRule.title}. Expected: ${consoleRule.expected} ${consoleRule.whyItMatters}`,
      `Fix: ${consoleRule.fixHint}`,
      NO_TARGET_CLOSING_LINE,
    ]);
  });

  test('fixPromptFor lists at most 10 occurrences and counts the rest', () => {
    const occurrences = Array.from({ length: 13 }, (_, index) =>
      occurrence(`s${index}`, `#el-${index}`, { route: `/page-${index}`, measured: { count: index } }),
    );

    const lines = fixPromptFor({
      rule: consoleRule,
      route: ROUTE,
      url: URL,
      target: null,
      observed: 'logged an error',
      occurrences,
    }).split('\n');

    expect(lines[1]).toBe('Occurrences (13):');
    expect(lines.slice(2, 12)).toEqual(
      occurrences.slice(0, 10).map((_entry, index) => `/page-${index} #el-${index} — count=${index}`),
    );
    expect(lines[12]).toBe('… and 3 more');
    expect(lines[13]).toMatch(/^Rule: /);
  });

  test('shows exactly 10 occurrences without a "more" line', () => {
    const occurrences = Array.from({ length: 10 }, (_, index) => occurrence(`s${index}`, `#el-${index}`));

    const prompt = fixPromptFor({
      rule: consoleRule,
      route: ROUTE,
      url: URL,
      target: null,
      observed: 'logged an error',
      occurrences,
    });

    expect(prompt).toContain('Occurrences (10):');
    expect(prompt).not.toContain('more');
  });

  test('keeps a multi-line measurement on its occurrence line', () => {
    const prompt = fixPromptFor({
      rule: consoleRule,
      route: ROUTE,
      url: URL,
      target: null,
      observed: 'logged an error',
      occurrences: [occurrence('s1', null, { measured: { message: 'Failed\n  at app.js:1\n' } })],
    });

    expect(prompt).toContain('\n/settings page — message=Failed at app.js:1\n');
  });

  test('writes no occurrence block for an empty list', () => {
    const withEmpty = fixPromptFor({
      rule: focusRule,
      route: ROUTE,
      url: URL,
      target: SAVE_BUTTON,
      observed: 'shows no change',
      occurrences: [],
    });
    const without = fixPromptFor({
      rule: focusRule,
      route: ROUTE,
      url: URL,
      target: SAVE_BUTTON,
      observed: 'shows no change',
    });

    expect(withEmpty).toBe(without);
  });
});
