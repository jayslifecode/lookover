// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const TOKENS_CSS = readFileSync(new URL('../src/theme/tokens.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

type Theme = 'dark' | 'light';

interface CssRule {
  /** The selector list or at-rule before the block, its whitespace collapsed. */
  readonly prelude: string;
  /** The prelude of the rule this one is nested in (an `@media` query), or `null` at the top level. */
  readonly parent: string | null;
  readonly body: string;
  /** Where the block opens in the stylesheet: a later rule of the same specificity wins. */
  readonly start: number;
}

/** Every rule of the stylesheet with a block, nested ones included. */
function rulesOf(css: string): CssRule[] {
  let rules: CssRule[] = [];
  let open: { prelude: string; start: number }[] = [];
  let preludeStart = 0;
  Array.from(css).forEach((char, index) => {
    if (char === '{') {
      open = [
        ...open,
        { prelude: css.slice(preludeStart, index).replace(/\s+/g, ' ').trim(), start: index + 1 },
      ];
    } else if (char === '}') {
      const rule = open.at(-1);
      open = open.slice(0, -1);
      if (rule !== undefined) {
        const parent = open.at(-1)?.prelude ?? null;
        rules = [
          ...rules,
          { prelude: rule.prelude, parent, body: css.slice(rule.start, index), start: rule.start },
        ];
      }
    }
    if (char === '{' || char === '}' || char === ';') preludeStart = index + 1;
  });
  return rules;
}

const RULES = rulesOf(TOKENS_CSS);

/** The rule nested in `parent` (`null`: at the top level) whose selector list includes `selector`. */
function ruleFor(selector: string, parent: string | null = null): CssRule | undefined {
  return RULES.find(
    (rule) => rule.parent === parent && rule.prelude.split(',').some((listed) => listed.trim() === selector),
  );
}

/** The custom properties declared in one rule's block, by name. */
function declarationsIn(selector: string, parent: string | null = null): Record<string, string> {
  const body = ruleFor(selector, parent)?.body ?? '';
  const entries = body
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.startsWith('--'))
    .map((declaration) => {
      const colon = declaration.indexOf(':');
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()] as const;
    });
  return Object.fromEntries(entries);
}

const tokensFor = (theme: Theme) => declarationsIn(`[data-theme="${theme}"]`);
const themeInline = () => declarationsIn('@theme inline');
/** <html> before use-theme.ts has set its `data-theme`: the first paint. */
const NO_THEME_YET = ':root:not([data-theme])';
const SYSTEM_PREFERS_LIGHT = '@media (prefers-color-scheme: light)';

/** Spec §11's colours, and the mockup's surface tokens, that both palettes define. */
const PALETTE_TOKENS = [
  '--bg-0',
  '--bg-1',
  '--bg-2',
  '--line',
  '--line-strong',
  '--ink',
  '--ink-2',
  '--ink-3',
  '--accent',
  '--accent-ink',
  '--high',
  '--medium',
  '--low',
  '--pass',
  '--glass-tint',
  '--glass-edge',
  '--glass-sheen',
  '--glass-spot',
  '--glass-shadow',
  '--glow-a',
  '--glow-b',
];

test('tokens: every spec colour is defined in both themes', () => {
  for (const name of PALETTE_TOKENS) {
    expect(tokensFor('dark')[name], `${name} in dark`).toBeDefined();
    expect(tokensFor('light')[name], `${name} in light`).toBeDefined();
  }
  expect(tokensFor('dark')['--accent']).toBe('#5b8def');
  expect(tokensFor('light')['--accent']).toBe('#2f6be0');
});

test('tokens: the spec values of the surfaces and severities', () => {
  expect(tokensFor('dark')).toMatchObject({
    '--bg-0': '#060a13',
    '--bg-1': '#0b1222',
    '--bg-2': '#111b31',
    '--high': '#f0616d',
    '--medium': '#efb75a',
    '--low': '#7dd3a8',
  });
  expect(tokensFor('light')).toMatchObject({ '--bg-0': '#eef1f7', '--bg-1': '#f6f8fc', '--bg-2': '#ffffff' });
});

test('tokens: mapped into Tailwind with @theme inline, with the report fonts and radius', () => {
  const theme = themeInline();
  for (const name of PALETTE_TOKENS.filter((token) => !token.startsWith('--glass-shadow'))) {
    expect(theme[`--color-${name.slice(2)}`], name).toBe(`var(${name})`);
  }
  expect(theme['--shadow-glass']).toBe('var(--glass-shadow)');
  expect(theme['--font-sans']).toMatch(/^"Manrope Variable"/);
  expect(theme['--font-mono']).toMatch(/^"JetBrains Mono Variable"/);
  expect(theme['--radius-lg']).toBe('18px');
});

test('tokens: before the theme is set, the first paint has the palette the system prefers', () => {
  const dark = ruleFor(NO_THEME_YET);
  const light = ruleFor(NO_THEME_YET, SYSTEM_PREFERS_LIGHT);

  // Dark, the fallback, unless the system prefers light: what use-theme.ts picks once it runs.
  expect(dark).toBe(ruleFor('[data-theme="dark"]'));
  expect(Object.keys(tokensFor('dark'))).toEqual(expect.arrayContaining(PALETTE_TOKENS));
  expect(declarationsIn(NO_THEME_YET, SYSTEM_PREFERS_LIGHT)).toEqual(tokensFor('light'));
  expect(light?.body).toMatch(/color-scheme:\s*light;/);
  expect(light?.start).toBeGreaterThan(dark?.start ?? Number.POSITIVE_INFINITY);
});
