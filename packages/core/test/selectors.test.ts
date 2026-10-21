import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { extractElements } from '../src/map/elements.js';
import { BUILD_SELECTOR_SOURCE, type SelectorCandidate, stableSelector } from '../src/map/selectors.js';
import type { ElementRef } from '../src/map/types.js';
import { redact } from '../src/util/redact.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/site', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };
const TOKEN_HREF = '/reset?token=eyJhbGciOi.eyJzdWIiOi.c2ln';

function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

describe('stableSelector', () => {
  test('keeps a plain selector', () => {
    const candidate = {
      selector: '[data-testid="save"]',
      path: 'body > main:nth-of-type(1) > button:nth-of-type(1)',
    };

    expect(stableSelector(candidate)).toBe('[data-testid="save"]');
  });

  test('rejects a selector that redaction changes, for the path', () => {
    const candidate = {
      selector: 'a[href="/r?token=eyJ.eyJ.sig"]',
      path: 'body > a:nth-of-type(1)',
    };

    expect(redact(candidate.selector)).not.toBe(candidate.selector);
    expect(stableSelector(candidate)).toBe('body > a:nth-of-type(1)');
  });

  test('rejects a selector holding an email address', () => {
    const candidate = { selector: 'a[href="mailto:jay@example.com"]', path: 'body > a:nth-of-type(1)' };

    expect(stableSelector(candidate)).toBe('body > a:nth-of-type(1)');
  });

  test('returns null when neither the selector nor the path survives redaction', () => {
    const candidate = {
      selector: '[data-testid="token=abc123"]',
      path: 'body > sk_live_abcdefgh1234:nth-of-type(1)',
    };

    expect(redact(candidate.path)).not.toBe(candidate.path);
    expect(stableSelector(candidate)).toBeNull();
  });

  test('does not look at the path when the selector is stable', () => {
    expect(stableSelector({ selector: '#x', path: 'body > sk_live_abcdefgh1234:nth-of-type(1)' })).toBe('#x');
  });
});

describe('selectors on a page with a token in a link', () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    session = await BrowserSession.launch({ viewport: VIEWPORT, allowHosts: [], onEvent: () => {} });
    ipage = await session.newPage();
    await ipage.page.goto(`${fixture.url}/token-link.html`);
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
  }, BROWSER_TIMEOUT_MS);

  /** Runs `BUILD_SELECTOR_SOURCE` through `page.evaluate` on the first element matching `css`. */
  function candidateFor(css: string): Promise<SelectorCandidate> {
    return ipage.page.evaluate<SelectorCandidate>(
      `(${BUILD_SELECTOR_SOURCE})(document.querySelector(${JSON.stringify(css)}))`,
    );
  }

  test('reports both the selector it prefers and the path from the body', async () => {
    expect(await candidateFor(`a[href="${TOKEN_HREF}"]`)).toEqual({
      selector: `a[href="${TOKEN_HREF}"]`,
      path: 'body > main:nth-of-type(1) > a:nth-of-type(1)',
    });
  });

  test('a link whose href would be redacted gets its body path, not the href', async () => {
    const selector = stableSelector(await candidateFor(`a[href="${TOKEN_HREF}"]`));

    expect(selector).toMatch(/^body > /);
    expect(selector).not.toContain('token');
  });

  test('a plain selector is kept', async () => {
    expect(stableSelector(await candidateFor('#support'))).toBe('#support');
    expect(stableSelector(await candidateFor('[data-testid="save"]'))).toBe('[data-testid="save"]');
  });

  test('builds the path from tags and positions only, never from an id or a test id', async () => {
    expect(await candidateFor('#team > button')).toEqual({
      selector: '#team > button:nth-of-type(1)',
      path: 'body > section:nth-of-type(1) > button:nth-of-type(1)',
    });
    expect(await candidateFor('[data-testid="save"]')).toMatchObject({
      path: 'body > main:nth-of-type(1) > button:nth-of-type(1)',
    });
  });

  describe('as extractElements stores them', () => {
    let elements: ElementRef[];

    beforeAll(async () => {
      ({ elements } = await extractElements(ipage));
    }, BROWSER_TIMEOUT_MS);

    test('gives the token link its body path', () => {
      const link = defined(
        elements.find((element) => element.name === 'Reset your password'),
        'the token link',
      );

      expect(link.selector).toBe('body > main:nth-of-type(1) > a:nth-of-type(1)');
    });

    test('stores only selectors that redaction leaves as they are', () => {
      expect(elements.map((element) => element.name)).toEqual([
        'Reset your password',
        'Support',
        'Save',
        'Invite',
      ]);
      for (const { selector } of elements) {
        expect(redact(selector)).toBe(selector);
      }
    });

    test('stores selectors that each resolve to exactly one element', async () => {
      const counts = await Promise.all(
        elements.map((element) => ipage.page.locator(element.selector).count()),
      );

      expect(counts).toEqual(elements.map(() => 1));
    });
  });
});
