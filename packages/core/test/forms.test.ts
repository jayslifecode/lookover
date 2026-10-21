import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserSession, type InstrumentedPage } from '../src/browser/session.js';
import { extractForms } from '../src/map/forms.js';
import type { Box, FieldInfo, FormInfo } from '../src/map/types.js';
import { redact } from '../src/util/redact.js';
import { type FixtureServer, serveFixture } from './fixtures/serve.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/forms', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const VIEWPORT = { name: 'desktop', width: 1280, height: 800 };
/** Far enough down the 3,000px fixture page that the viewport no longer shows the forms. */
const SCROLL_OFFSET_PX = 120;
/** Different measuring APIs may round sub-pixel layout differently in the last digits. */
const BOX_PRECISION_DIGITS = 2;

function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

function formAt(forms: readonly FormInfo[], selector: string): FormInfo {
  return defined(
    forms.find((form) => form.selector === selector),
    `a form at ${selector}`,
  );
}

function fieldNamed(form: FormInfo, name: string): FieldInfo {
  return defined(
    form.fields.find((field) => field.name === name),
    `a field named ${name} in ${form.selector}`,
  );
}

function expectBoxCloseTo(actual: Box, expected: Box): void {
  expect(actual.x).toBeCloseTo(expected.x, BOX_PRECISION_DIGITS);
  expect(actual.y).toBeCloseTo(expected.y, BOX_PRECISION_DIGITS);
  expect(actual.width).toBeCloseTo(expected.width, BOX_PRECISION_DIGITS);
  expect(actual.height).toBeCloseTo(expected.height, BOX_PRECISION_DIGITS);
}

describe('extractForms', { timeout: BROWSER_TIMEOUT_MS }, () => {
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

  describe('on the forms fixture', () => {
    let forms: FormInfo[];
    let profile: FormInfo;

    beforeAll(async () => {
      await open('index.html');
      forms = await extractForms(ipage);
      profile = formAt(forms, '#profile');
    }, BROWSER_TIMEOUT_MS);

    test('lists each form in document order, then the virtual form for fields outside any form', () => {
      expect(forms.map((form) => form.selector)).toEqual(['#profile', '#search-form', '#newsletter', 'body']);
    });

    test('reads the action as written and the lowercased method, defaulting to get', () => {
      expect(forms.map(({ selector, action, method }) => ({ selector, action, method }))).toEqual([
        { selector: '#profile', action: '/profile', method: 'post' },
        { selector: '#search-form', action: null, method: 'get' },
        { selector: '#newsletter', action: null, method: 'get' },
        { selector: 'body', action: null, method: 'none' },
      ]);
    });

    test('lists inputs, selects and textareas but not hidden inputs or buttons, hidden fields included', () => {
      expect(profile.fields.map((field) => field.name)).toEqual([
        'phone',
        'email',
        'start',
        'country',
        'notes',
        'promo',
      ]);
      expect(profile.fields.map((field) => field.type)).toEqual([
        'tel',
        'email',
        'date',
        'select',
        'textarea',
        'text',
      ]);
    });

    test('resolves labels from a label for, aria-label, a wrapping label and the placeholder', () => {
      expect(profile.fields.map(({ name, label, labelSource }) => ({ name, label, labelSource }))).toEqual([
        { name: 'phone', label: 'Phone number', labelSource: 'label' },
        { name: 'email', label: 'Email address', labelSource: 'aria-label' },
        { name: 'start', label: 'Start date', labelSource: 'label' },
        { name: 'country', label: 'Country', labelSource: 'label' },
        { name: 'notes', label: 'Anything we should know?', labelSource: 'placeholder' },
        { name: 'promo', label: null, labelSource: null },
      ]);
    });

    test('copies the constraint attributes of a field verbatim', () => {
      expect(fieldNamed(profile, 'phone')).toMatchObject({
        required: true,
        pattern: '\\d{8}',
        minLength: null,
        maxLength: 8,
        min: null,
        max: null,
        inputMode: 'numeric',
      });
      expect(fieldNamed(profile, 'start')).toMatchObject({
        required: false,
        pattern: null,
        min: '2026-01-01',
        max: '2026-12-31',
        inputMode: null,
      });
      expect(fieldNamed(profile, 'notes')).toMatchObject({ minLength: 10, maxLength: 200 });
    });

    test('takes the first submit control of the form as its submit button', () => {
      const { submit } = profile;

      expect(submit).toMatchObject({
        selector: '#save',
        role: 'button',
        name: 'Save',
        tag: 'button',
        disabled: false,
        focusable: true,
      });
      expect(submit).not.toHaveProperty('backendNodeId');
    });

    test('names an input submit by its value and a button without a type by its text', () => {
      expect(formAt(forms, '#search-form').submit).toMatchObject({ name: 'Go', tag: 'input' });
      expect(formAt(forms, '#newsletter')).toMatchObject({
        fields: [],
        submit: { name: 'Subscribe', tag: 'button' },
      });
    });

    test('puts a field outside any form in a virtual form with no submit', () => {
      const virtual = formAt(forms, 'body');

      expect(virtual.submit).toBeNull();
      expect(virtual.fields).toHaveLength(1);
      expect(virtual.fields[0]).toMatchObject({
        name: 'search',
        label: null,
        labelSource: null,
        type: 'text',
        required: false,
        pattern: null,
        minLength: null,
        maxLength: null,
        min: null,
        max: null,
        inputMode: null,
      });
    });

    test('returns selectors that each resolve to exactly one element', async () => {
      const selectors = forms.flatMap((form) => [
        ...(form.selector === 'body' ? [] : [form.selector]),
        ...form.fields.map((field) => field.selector),
        ...(form.submit === null ? [] : [form.submit.selector]),
      ]);

      const counts = await Promise.all(selectors.map((selector) => ipage.page.locator(selector).count()));

      expect(selectors).toContain('#profile');
      expect(counts).toEqual(selectors.map(() => 1));
    });

    test('measures the submit button in document coordinates, scrolled or not', async () => {
      const unscrolled = defined(profile.submit, 'a submit button').box;
      await ipage.page.evaluate((offset) => window.scrollTo(0, offset), SCROLL_OFFSET_PX);
      const scrolled = defined(
        formAt(await extractForms(ipage), '#profile').submit,
        'a submit button after scrolling',
      ).box;

      expect(await ipage.page.evaluate(() => window.scrollY)).toBe(SCROLL_OFFSET_PX);
      expect(unscrolled.width).toBeGreaterThan(0);
      expectBoxCloseTo(unscrolled, await documentRectOf('#save'));
      expectBoxCloseTo(scrolled, unscrolled);
    });
  });

  describe('on the ARIA fixture', () => {
    let forms: FormInfo[];

    beforeAll(async () => {
      await open('aria.html');
      forms = await extractForms(ipage);
    }, BROWSER_TIMEOUT_MS);

    test('has no virtual form when every field belongs to a form', () => {
      expect(forms.map((form) => form.selector)).toEqual(['#compose']);
      expect(forms[0]).toMatchObject({ action: '', method: 'get' });
    });

    test('lists textbox and combobox roles and applies the label order', () => {
      const [compose] = forms;

      expect(
        defined(compose, 'the compose form').fields.map(({ name, label, labelSource, type, required }) => ({
          name,
          label,
          labelSource,
          type,
          required,
        })),
      ).toEqual([
        { name: null, label: 'Message', labelSource: 'aria-label', type: 'textbox', required: true },
        {
          name: null,
          label: 'Priority level',
          labelSource: 'aria-labelledby',
          type: 'combobox',
          required: false,
        },
        { name: 'nick', label: 'Nickname', labelSource: 'label', type: 'text', required: false },
        { name: 'alias', label: 'Alias', labelSource: 'placeholder', type: 'text', required: false },
        {
          name: 'legal',
          label: 'Legal name',
          labelSource: 'aria-labelledby',
          type: 'text',
          required: false,
        },
        { name: 'tags', label: 'Tags', labelSource: 'aria-label', type: 'select-multiple', required: false },
        { name: 'mystery', label: null, labelSource: null, type: 'mystery', required: false },
        { name: 'remote', label: 'Remote', labelSource: 'aria-label', type: 'text', required: false },
      ]);
    });

    test('ignores length attributes that are not non-negative integers', () => {
      const [compose] = forms;

      expect(fieldNamed(defined(compose, 'the compose form'), 'mystery')).toMatchObject({
        minLength: null,
        maxLength: null,
      });
    });

    test('keeps fields and a submit button tied to the form by its form attribute', () => {
      const [compose] = forms;

      expect(defined(compose, 'the compose form').fields.map((field) => field.name)).toContain('remote');
      expect(compose?.submit).toMatchObject({ selector: '#send', name: 'Send' });
    });
  });

  describe('on a form whose test ids redaction would rewrite', () => {
    let forms: FormInfo[];

    beforeAll(async () => {
      await open('token.html');
      forms = await extractForms(ipage);
    }, BROWSER_TIMEOUT_MS);

    test('gives the form, a field and the submit button their body path, and leaves a plain selector alone', () => {
      const [form] = forms;

      expect(forms).toHaveLength(1);
      expect(defined(form, 'the form').selector).toBe('body > form:nth-of-type(1)');
      expect(form?.fields.map((field) => field.selector)).toEqual([
        'body > form:nth-of-type(1) > input:nth-of-type(1)',
        'input[name="email"]',
      ]);
      expect(form?.submit?.selector).toBe('body > form:nth-of-type(1) > button:nth-of-type(1)');
    });

    test('stores only selectors that redaction leaves as they are, each resolving to one element', async () => {
      const selectors = forms.flatMap((form) => [
        form.selector,
        ...form.fields.map((field) => field.selector),
        ...(form.submit === null ? [] : [form.submit.selector]),
      ]);

      const counts = await Promise.all(selectors.map((selector) => ipage.page.locator(selector).count()));

      expect(selectors.map((selector) => redact(selector))).toEqual(selectors);
      expect(counts).toEqual(selectors.map(() => 1));
    });
  });

  test('returns no forms for a page without any', async () => {
    await ipage.page.goto('about:blank');

    expect(await extractForms(ipage)).toEqual([]);
  });
});
