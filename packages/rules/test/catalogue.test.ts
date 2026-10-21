import { describe, expect, test } from 'vitest';
import {
  catalogueSchema,
  RULE_IDS,
  RULES,
  type Rule,
  ruleById,
  ruleSchema,
  SEVERITIES,
} from '../src/index.ts';

const WCAG_URL_PREFIX = 'https://www.w3.org/WAI/WCAG22/Understanding/';

/** id, severity, title, reference label, WCAG page slug: the catalogue as agreed, in file order. */
const EXPECTED_TABLE = [
  [
    'interaction.focus-visible-missing',
    'high',
    'Keyboard focus is not visible',
    'WCAG 2.2 · 2.4.7 Focus Visible',
    'focus-visible',
  ],
  [
    'interaction.focus-indicator-contrast',
    'medium',
    'The focus indicator is too faint',
    'WCAG 2.2 · 1.4.11 Non-text Contrast',
    'non-text-contrast',
  ],
  ['interaction.hover-state-missing', 'low', 'No hover feedback on a clickable control', null, null],
  [
    'interaction.text-contrast-fail',
    'high',
    'Text is unreadable against its background',
    'WCAG 2.2 · 1.4.3 Contrast (Minimum)',
    'contrast-minimum',
  ],
  [
    'interaction.text-contrast-low',
    'medium',
    'Text contrast is below the minimum',
    'WCAG 2.2 · 1.4.3 Contrast (Minimum)',
    'contrast-minimum',
  ],
  [
    'interaction.target-size',
    'medium',
    'Tap target is smaller than 24 by 24 pixels',
    'WCAG 2.2 · 2.5.8 Target Size (Minimum)',
    'target-size-minimum',
  ],
  [
    'interaction.keyboard-unreachable',
    'high',
    'Control cannot be reached with the keyboard',
    'WCAG 2.2 · 2.1.1 Keyboard',
    'keyboard',
  ],
  [
    'interaction.positive-tabindex',
    'low',
    'A positive tabindex forces a custom focus order',
    'WCAG 2.2 · 2.4.3 Focus Order',
    'focus-order',
  ],
  [
    'interaction.focus-hidden',
    'medium',
    'Keyboard focus lands on something that cannot be seen',
    'WCAG 2.2 · 2.4.11 Focus Not Obscured (Minimum)',
    'focus-not-obscured-minimum',
  ],
  [
    'interaction.focus-trap',
    'high',
    'Keyboard focus gets stuck',
    'WCAG 2.2 · 2.1.2 No Keyboard Trap',
    'no-keyboard-trap',
  ],
  [
    'interaction.horizontal-overflow',
    'high',
    'The page scrolls sideways at this screen size',
    'WCAG 2.2 · 1.4.10 Reflow',
    'reflow',
  ],
  ['interaction.text-clipped', 'medium', 'Text is cut off without an ellipsis', null, null],
  ['observers.page-error', 'high', 'The page threw an error that nothing caught', null, null],
  ['observers.console-error', 'medium', 'The page logged an error to the console', null, null],
  ['observers.console-warning', 'low', 'The page logged a warning', null, null],
  ['observers.request-server-error', 'high', 'A request the page made failed on the server', null, null],
  ['observers.request-client-error', 'medium', 'A request the page made was rejected', null, null],
  ['observers.request-network-error', 'high', 'A request the page made never got an answer', null, null],
  ['observers.raw-value', 'high', 'A placeholder value leaked into the page', null, null],
  ['observers.raw-i18n-key', 'medium', 'A translation key is shown instead of its text', null, null],
  ['observers.unresolved-placeholder', 'medium', 'A template placeholder was not filled in', null, null],
];

const VALID_RULE: Rule = {
  id: 'interaction.example-rule',
  source: 'interaction',
  severity: 'medium',
  title: 'Something is not right',
  expected: 'A correct app does the right thing.',
  whyItMatters: 'People notice when it does not.',
  fixHint: 'Make it do the right thing.',
  reference: null,
};

describe('the loaded catalogue', () => {
  test('every catalogue validates and ids are unique and prefixed by their source', () => {
    expect(RULES.length).toBe(21);
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);
    for (const rule of RULES) expect(rule.id.startsWith(`${rule.source}.`)).toBe(true);
  });

  test('holds 12 interaction rules and 9 observer rules, and RULE_IDS lists them all', () => {
    expect(RULES.filter((rule) => rule.source === 'interaction')).toHaveLength(12);
    expect(RULES.filter((rule) => rule.source === 'observers')).toHaveLength(9);
    expect(RULE_IDS.size).toBe(21);
    expect(RULE_IDS.has('observers.raw-i18n-key')).toBe(true);
  });

  test('every rule is written out in full and every title is plain', () => {
    for (const rule of RULES) {
      expect(rule.expected.length, rule.id).toBeGreaterThan(0);
      expect(rule.whyItMatters.length, rule.id).toBeGreaterThan(0);
      expect(rule.fixHint.length, rule.id).toBeGreaterThan(0);
      expect(rule.title.endsWith('.'), rule.id).toBe(false);
    }
  });

  test('a WCAG reference links to its page on w3.org', () => {
    for (const rule of RULES) {
      if (rule.reference === null) continue;
      expect(rule.reference.standard, rule.id).toBe('WCAG 2.2');
      expect(rule.reference.url, rule.id).toMatch(
        /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/[a-z-]+\.html$/,
      );
    }
  });

  test('ids, severities, titles and references are exactly the agreed table', () => {
    const projected = RULES.map((rule) => [
      rule.id,
      rule.severity,
      rule.title,
      rule.reference === null ? null : `${rule.reference.standard} · ${rule.reference.criterion}`,
      rule.reference === null ? null : rule.reference.url.slice(WCAG_URL_PREFIX.length, -'.html'.length),
    ]);
    expect(projected).toEqual(EXPECTED_TABLE);
  });
});

describe('ruleById', () => {
  test('ruleById returns the rule and throws for an unknown id', () => {
    expect(ruleById('interaction.target-size').severity).toBe('medium');
    expect(() => ruleById('interaction.nope')).toThrow('Unknown rule interaction.nope');
  });

  test('an unknown id is a plain Error, not a LookoverError', () => {
    let thrown: unknown = null;
    try {
      ruleById('observers.nope');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('Error');
  });
});

describe('ruleSchema', () => {
  test('accepts a complete rule, with and without a reference', () => {
    expect(ruleSchema.safeParse(VALID_RULE).success).toBe(true);
    const withReference: Rule = {
      ...VALID_RULE,
      reference: { standard: 'WCAG 2.2', criterion: '2.4.7 Focus Visible', url: 'https://example.com/a' },
    };
    expect(ruleSchema.safeParse(withReference).success).toBe(true);
  });

  test('rejects a severity outside the four and a title ending in a full stop', () => {
    expect(SEVERITIES).toEqual(['blocker', 'high', 'medium', 'low']);
    expect(ruleSchema.safeParse({ ...VALID_RULE, severity: 'critical' }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...VALID_RULE, title: 'Something is not right.' }).success).toBe(false);
  });

  test('rejects a source that differs from the id prefix and an id that is not source.kebab-case', () => {
    expect(ruleSchema.safeParse({ ...VALID_RULE, source: 'observers' }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...VALID_RULE, id: 'interaction.Not_Kebab' }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...VALID_RULE, id: 'interaction' }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...VALID_RULE, id: 'elsewhere.thing', source: 'elsewhere' }).success).toBe(
      false,
    );
  });

  test('rejects an empty text, a reference without a url, and a field it does not know', () => {
    expect(ruleSchema.safeParse({ ...VALID_RULE, fixHint: '' }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...VALID_RULE, reference: { standard: 'WCAG 2.2' } }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...VALID_RULE, extra: true }).success).toBe(false);
  });
});

describe('catalogueSchema', () => {
  test('accepts version 1 with rules and rejects any other version', () => {
    expect(catalogueSchema.safeParse({ version: 1, rules: [VALID_RULE] }).success).toBe(true);
    expect(catalogueSchema.safeParse({ version: 2, rules: [VALID_RULE] }).success).toBe(false);
  });

  test('rejects two rules with the same id', () => {
    const result = catalogueSchema.safeParse({ version: 1, rules: [VALID_RULE, { ...VALID_RULE }] });
    expect(result.success).toBe(false);
  });
});
