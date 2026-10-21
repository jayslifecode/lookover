import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { boxFor } from '../src/browser/cdp.js';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { extractElements, INTERACTIVE_ROLES, MAX_ELEMENTS_PER_SCREEN } from '../src/map/elements.js';
import { BUILD_SELECTOR_SOURCE } from '../src/map/selectors.js';
import type { Box, ElementRef } from '../src/map/types.js';
import { redact } from '../src/util/redact.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/elements', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };
/** Different measuring APIs may round sub-pixel layout differently in the last digits. */
const BOX_PRECISION_DIGITS = 2;
/** Ids that frameworks generate per render, plus a digits-only id; none may appear in a selector. */
const UNSTABLE_IDS = [
  ':r5:', // React 18 and 19.0 useId, client
  ':R6:', // React 18 and 19.0 useId, server
  '«r1»', // React 19.1 useId, client
  '«R3»', // React 19.1 useId, server
  '_r_1_', // React 19.2 useId, client
  '_R_2_', // React 19.2 useId, server
  'radix-:r2:',
  'headlessui-menu-button-1',
  'mui-123',
  'react-aria-7',
  '1234',
];
/** Chromium exposes a date input's year, month and day fields and its picker button as controls. */
const DATE_INPUT_OWN_CONTROLS = 4;

function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

function expectBoxCloseTo(actual: Box, expected: Box): void {
  expect(actual.x).toBeCloseTo(expected.x, BOX_PRECISION_DIGITS);
  expect(actual.y).toBeCloseTo(expected.y, BOX_PRECISION_DIGITS);
  expect(actual.width).toBeCloseTo(expected.width, BOX_PRECISION_DIGITS);
  expect(actual.height).toBeCloseTo(expected.height, BOX_PRECISION_DIGITS);
}

describe('extractElements', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let session: BrowserSession;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    session = await BrowserSession.launch({ viewport: VIEWPORT, allowHosts: [], onEvent: () => {} });
    ipage = await session.newPage();
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await session.close();
    await fixture.close();
  }, BROWSER_TIMEOUT_MS);

  async function open(file: string): Promise<void> {
    await ipage.page.goto(`${fixture.url}/${file}`);
  }

  /** One `DOM.getDocument` for all selectors: each call invalidates the node ids of the last one. */
  async function backendIdsOf(selectors: readonly string[]): Promise<number[]> {
    const { root } = await ipage.cdp.send('DOM.getDocument');
    return Promise.all(
      selectors.map(async (selector) => {
        const { nodeId } = await ipage.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        const { node } = await ipage.cdp.send('DOM.describeNode', { nodeId });
        return node.backendNodeId;
      }),
    );
  }

  /** The element's border box in document coordinates, measured in the page. */
  function documentRectOf(selector: string): Promise<Box> {
    return ipage.page.evaluate((target) => {
      const element = document.querySelector(target);
      if (element === null) {
        throw new Error(`no element matches ${target}`);
      }
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    }, selector);
  }

  /** Runs `BUILD_SELECTOR_SOURCE` through `page.evaluate` on every element matching `css`; the selector it prefers. */
  function buildSelectorsFor(css: string): Promise<string[]> {
    return ipage.page.evaluate<string[]>(
      `Array.from(document.querySelectorAll(${JSON.stringify(css)}), (el) => (${BUILD_SELECTOR_SOURCE})(el).selector)`,
    );
  }

  test('treats the widget roles and the native date, colour and disclosure roles as interactive', () => {
    expect([...INTERACTIVE_ROLES].toSorted()).toEqual(
      [
        'ColorWell',
        'Date',
        'DateTime',
        'DisclosureTriangle',
        'InputTime',
        'button',
        'link',
        'textbox',
        'searchbox',
        'checkbox',
        'radio',
        'combobox',
        'listbox',
        'option',
        'menuitem',
        'menuitemcheckbox',
        'menuitemradio',
        'slider',
        'spinbutton',
        'switch',
        'tab',
      ].toSorted(),
    );
    expect(MAX_ELEMENTS_PER_SCREEN).toBe(500);
  });

  describe('on the element fixture', () => {
    let elements: ElementRef[];
    let total: number;

    beforeAll(async () => {
      await open('index.html');
      ({ elements, total } = await extractElements(ipage));
    }, BROWSER_TIMEOUT_MS);

    function named(name: string): ElementRef {
      return defined(
        elements.find((element) => element.name === name),
        `an element named ${name}`,
      );
    }

    test('lists every visible interactive element once, in document order', () => {
      expect(elements.map((element) => element.name)).toEqual([
        'Save',
        'Generated id',
        'Organisations',
        'Phone',
        'Custom',
        'Off',
        'Edit',
        'Edit',
        'Email',
        'Say "hi"',
        'Answer',
        'First',
        'Second',
        'Due',
        'More',
        'Bottom',
      ]);
      // The date input's own controls are candidates, but live in the browser's shadow tree.
      expect(total).toBe(elements.length + DATE_INPUT_OWN_CONTROLS);
    });

    test('lists native date and disclosure controls under their Chromium roles', () => {
      const due = named('Due');

      expect(due).toMatchObject({ role: 'Date', tag: 'input', selector: '#due' });
      expect(due.box.width).toBeGreaterThan(0);
      expect(due.box.height).toBeGreaterThan(0);
      expect(elements.filter((element) => element.role === 'spinbutton')).toEqual([]);
      expect(named('More')).toMatchObject({ role: 'DisclosureTriangle', tag: 'summary' });
    });

    test('prefers the test id, then a stable id, then the link href', () => {
      expect(named('Save').selector).toBe('[data-testid="save"]');
      expect(named('Phone').selector).toBe('#phone');
      expect(named('Organisations').selector).toBe('a[href="/orgs"]');
    });

    test('falls back to a path for a generated id', async () => {
      const { selector } = named('Generated id');

      expect(selector).not.toContain(':r1:');
      expect(await ipage.page.locator(selector).count()).toBe(1);
    });

    test('falls back to a path for a digits-only id', () => {
      expect(named('Answer').selector).not.toContain('#42');
    });

    test('uses the name, then the aria-label, quoting the value', () => {
      expect(named('Email').selector).toBe('input[name="email"]');
      expect(named('Say "hi"').selector).toBe('button[aria-label="Say \\"hi\\""]');
    });

    test('passes over a test id that is not unique', () => {
      expect(named('First').selector).toBe('button[name="first"]');
      expect(named('Second').selector).not.toContain('dup');
    });

    test('anchors a path at the nearest ancestor with a stable id', () => {
      const edits = elements.filter((element) => element.name === 'Edit');

      expect(edits.map((element) => element.selector)).toEqual([
        '#settings > button:nth-of-type(1)',
        '#settings > button:nth-of-type(2)',
      ]);
    });

    test('returns selectors that each resolve to exactly their own element', async () => {
      const counts = await Promise.all(
        elements.map((element) => ipage.page.locator(element.selector).count()),
      );
      const backendIds = await backendIdsOf(elements.map((element) => element.selector));

      expect(counts).toEqual(elements.map(() => 1));
      expect(backendIds).toEqual(elements.map((element) => element.backendNodeId));
    });

    test('builds only selectors that redaction leaves as they are', () => {
      expect(elements.map((element) => redact(element.selector))).toEqual(
        elements.map((element) => element.selector),
      );
    });

    test('leaves out a hidden button', () => {
      expect(elements.map((element) => element.name)).not.toContain('Nope');
    });

    test('marks a disabled button disabled and not focusable', () => {
      expect(named('Off')).toMatchObject({ disabled: true, focusable: false });
      expect(named('Save')).toMatchObject({ disabled: false, focusable: true });
      expect(named('Custom')).toMatchObject({ disabled: false, focusable: true });
    });

    test('takes the role and name from the accessibility tree and the tag from the DOM', () => {
      expect(named('Custom')).toMatchObject({ role: 'button', tag: 'div' });
      expect(named('Organisations')).toMatchObject({ role: 'link', tag: 'a' });
      expect(named('Phone')).toMatchObject({ role: 'textbox', tag: 'input' });
      expect(named('Save')).toMatchObject({ role: 'button', tag: 'button' });
    });

    test('measures every element with a positive box', () => {
      for (const { name, box } of elements) {
        expect({ name, isPositive: box.width > 0 && box.height > 0 }).toEqual({ name, isPositive: true });
      }
    });
  });

  describe('on a page whose attributes hold email addresses and contact links', () => {
    let elements: ElementRef[];

    beforeAll(async () => {
      await open('contact.html');
      ({ elements } = await extractElements(ipage));
    }, BROWSER_TIMEOUT_MS);

    function selectorOf(name: string): string {
      return defined(
        elements.find((element) => element.name === name),
        `an element named ${name}`,
      ).selector;
    }

    // A persisted map holds redacted selectors; one that redaction changed would match nothing live.
    test('builds only selectors that redaction leaves as they are', () => {
      expect(elements).toHaveLength(9);
      for (const { selector } of elements) {
        expect(redact(selector)).toBe(selector);
        expect(selector).not.toMatch(/@|mailto:|tel:/i);
      }
    });

    test('still gives each mailto and tel link a selector unique to it', async () => {
      const links = elements.filter((element) => element.role === 'link');
      const counts = await Promise.all(links.map((link) => ipage.page.locator(link.selector).count()));

      expect(links.map((link) => link.name)).toEqual(['Email support', 'Email sales', 'Call us', 'Team']);
      expect(counts).toEqual([1, 1, 1, 1]);
      expect(await backendIdsOf(links.map((link) => link.selector))).toEqual(
        links.map((link) => link.backendNodeId),
      );
      expect(selectorOf('Email support')).toBe('body > main:nth-of-type(1) > a:nth-of-type(1)');
    });

    test('falls through to the next safe attribute, or to a path', () => {
      expect(selectorOf('Contact')).toBe('input[aria-label="Contact"]');
      expect(selectorOf('Invite')).toBe('body > main:nth-of-type(1) > button:nth-of-type(1)');
      expect(selectorOf('Profile')).toBe('body > main:nth-of-type(1) > button:nth-of-type(2)');
    });

    test('anchors a path at a stable id, but never at an id holding an address', () => {
      expect(selectorOf('Team')).toBe('#team > a:nth-of-type(1)');
      expect(selectorOf('Owner')).toBe('body > section:nth-of-type(2) > button:nth-of-type(1)');
    });
  });

  test('measures boxes in document coordinates on a scrolled page', async () => {
    await open('index.html');
    await ipage.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const scroll = await ipage.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));

    const { elements } = await extractElements(ipage);
    const bottom = defined(
      elements.find((element) => element.name === 'Bottom'),
      'the Bottom button',
    );
    const cdpBox = defined(
      await boxFor(ipage.cdp, defined(bottom.backendNodeId, 'a backend node id')),
      'a CDP box model',
    );

    expect(scroll.y).toBeGreaterThan(0);
    expect(bottom.box.y).toBeGreaterThan(VIEWPORT.height);
    expectBoxCloseTo(bottom.box, await documentRectOf('[data-testid="bottom"]'));
    // DOM.getBoxModel reports the border quad relative to the viewport; shifted by the scroll
    // offset it must land on the same document-relative box.
    expectBoxCloseTo({ ...cdpBox, x: cdpBox.x + scroll.x, y: cdpBox.y + scroll.y }, bottom.box);
  });

  test('leaves out controls inside shadow trees, which a document selector cannot reach', async () => {
    await open('index.html');
    const before = await extractElements(ipage);
    await ipage.page.evaluate(() => {
      const hostWith = (mode: ShadowRootMode, label: string): HTMLElement => {
        const host = document.createElement('div');
        const button = document.createElement('button');
        button.textContent = label;
        host.attachShadow({ mode }).append(button);
        return host;
      };
      document.body.append(hostWith('open', 'Inside open'), hostWith('closed', 'Inside closed'));
    });

    const { elements, total } = await extractElements(ipage);
    const backendIds = await backendIdsOf(elements.map((element) => element.selector));

    expect(elements.map((element) => element.name)).toEqual(before.elements.map((element) => element.name));
    expect(total).toBe(before.total + 2);
    expect(backendIds).toEqual(elements.map((element) => element.backendNodeId));
  });

  test('leaves out a control that has no selector redaction leaves alone, and still counts it', async () => {
    await open('index.html');
    const before = await extractElements(ipage);
    await ipage.page.evaluate(() => {
      // A tag name redaction rewrites as an API key: with no attribute to build a selector on, the
      // control's selector is its path, and the path changes too.
      const control = document.createElement('sk_live_abcdefgh1234');
      control.setAttribute('role', 'button');
      control.tabIndex = 0;
      control.textContent = 'Pay';
      document.body.append(control);
    });

    const { elements, total } = await extractElements(ipage);

    expect(elements.map((element) => element.name)).toEqual(before.elements.map((element) => element.name));
    expect(total).toBe(before.total + 1);
    for (const { selector } of elements) {
      expect(redact(selector)).toBe(selector);
    }
  });

  test('skips the options of a collapsed select and keeps those of a multiple select', async () => {
    await open('select.html');

    const { elements, total } = await extractElements(ipage);

    expect(elements.map(({ role, name, selector }) => ({ role, name, selector }))).toEqual([
      { role: 'combobox', name: 'Country', selector: '#country' },
      { role: 'listbox', name: 'Tags', selector: '#tags' },
      { role: 'option', name: 'Red', selector: '#tags > option:nth-of-type(1)' },
      { role: 'option', name: 'Blue', selector: '#tags > option:nth-of-type(2)' },
      { role: 'button', name: 'After', selector: 'body > button:nth-of-type(1)' },
    ]);
    expect(total).toBeLessThan(20);
  });

  test('builds selectors through page.evaluate', async () => {
    await open('index.html');

    expect(await buildSelectorsFor('#phone')).toEqual(['#phone']);
    expect(await buildSelectorsFor('[data-testid="save"]')).toEqual(['[data-testid="save"]']);
  });

  test.each(UNSTABLE_IDS)('never uses the generated or digits-only id %s as a selector', async (id) => {
    await open('index.html');
    await ipage.page.evaluate((unstableId) => {
      const button = document.createElement('button');
      button.id = unstableId;
      button.className = 'unstable';
      button.textContent = unstableId;
      document.body.append(button);
    }, id);

    const [selector] = await buildSelectorsFor('.unstable');

    expect(selector).toBeDefined();
    expect(selector).not.toContain('#');
    expect(await ipage.page.locator(defined(selector, 'a selector')).count()).toBe(1);
  });

  test('stops after 500 elements on a grid of 1,200 buttons and reports the total', async () => {
    await open('grid.html');

    const { elements, total } = await extractElements(ipage);

    expect(elements.length).toBe(500);
    expect(total).toBe(1200);
    expect(elements[0]?.name).toBe('Cell 1');
    expect(elements.at(-1)?.name).toBe('Cell 500');
    expect(elements.at(-1)?.selector).toBe('#grid > button:nth-of-type(500)');
  });
});
