import { fileURLToPath } from 'node:url';
import { type ElementRef, extractElements, type InstrumentedPage } from '@jayslifecode/lookover-core';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { evaluateSource, measureOn } from '../src/interaction/measure.js';
import { launchTestSession, type TestSession } from './helpers/session.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/measure', import.meta.url));
const BROWSER_TIMEOUT_MS = 30_000;
const READ_ID_SOURCE = 'function () { return this.id; }';
const JOIN_ARGS_SOURCE = 'function (separator, suffix) { return [this.id, suffix].join(separator); }';
const THROWING_SOURCE = 'function () { throw new Error("measurement exploded"); }';
/** No element has this backend node id in a fixture this small. */
const UNKNOWN_BACKEND_ID = 999_999;

describe('measureOn and evaluateSource', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let browser: TestSession;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    fixture = await serveFixture(FIXTURE_DIR);
    browser = await launchTestSession();
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser.close();
    await fixture.close();
  }, BROWSER_TIMEOUT_MS);

  beforeEach(async () => {
    ipage = await browser.newPage();
    await ipage.page.goto(`${fixture.url}/inline.html`);
  });

  afterEach(async () => {
    await ipage.close();
  });

  async function elementFor(selector: string): Promise<ElementRef> {
    const { elements } = await extractElements(ipage);
    const element = elements.find((candidate) => candidate.selector === selector);
    if (element?.backendNodeId === undefined)
      throw new Error(`no element ${selector} with a backend node id`);
    return element;
  }

  test('runs the source on the element its backend node id names', async () => {
    const element = await elementFor('#in-sentence');

    // A selector that matches nothing proves the backend node id is what found the element.
    expect(await measureOn(ipage.cdp, { ...element, selector: '#nope' }, READ_ID_SOURCE)).toBe('in-sentence');
  });

  test('finds the element by its selector when it has no backend node id', async () => {
    expect(await measureOn(ipage.cdp, { selector: '#alone' }, READ_ID_SOURCE)).toBe('alone');
  });

  test('passes the arguments through', async () => {
    expect(await measureOn(ipage.cdp, { selector: '#alone' }, JOIN_ARGS_SOURCE, ['/', 'x'])).toBe('alone/x');
  });

  test('is null when the selector matches nothing', async () => {
    expect(await measureOn(ipage.cdp, { selector: '#nope' }, READ_ID_SOURCE)).toBeNull();
  });

  test('is null when the backend node is gone with the document it was in', async () => {
    const element = await elementFor('#in-sentence');

    await ipage.page.reload();

    expect(await measureOn(ipage.cdp, element, READ_ID_SOURCE)).toBeNull();
  });

  test('is null when no node has the backend node id', async () => {
    expect(
      await measureOn(ipage.cdp, { selector: '#alone', backendNodeId: UNKNOWN_BACKEND_ID }, READ_ID_SOURCE),
    ).toBeNull();
  });

  test('rejects, rather than reporting the element gone, when the CDP session is detached', async () => {
    const element = await elementFor('#in-sentence');
    const detached = await browser.session.context.newCDPSession(ipage.page);
    await detached.detach();

    await expect(measureOn(detached, element, READ_ID_SOURCE)).rejects.toThrow();
  });

  test('rethrows when the source throws in the page', async () => {
    await expect(measureOn(ipage.cdp, { selector: '#alone' }, THROWING_SOURCE)).rejects.toThrow(
      /measurement exploded/,
    );
  });

  test('evaluateSource calls an element-less source and returns its result', async () => {
    expect(await evaluateSource(ipage.page, '() => document.title')).toBe('Inline fixture');
  });
});
