// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const TOKENS_CSS = readFileSync(new URL('../src/theme/tokens.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

type Theme = 'dark' | 'light';

/** The custom properties declared in one rule's block, by name. */
function declarationsIn(selector: string): Record<string, string> {
  const start = TOKENS_CSS.indexOf(`${selector} {`);
  if (start === -1) return {};
  const body = TOKENS_CSS.slice(TOKENS_CSS.indexOf('{', start) + 1, TOKENS_CSS.indexOf('}', start));
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
