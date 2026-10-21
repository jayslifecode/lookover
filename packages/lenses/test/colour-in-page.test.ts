import type { InstrumentedPage } from '@jayslifecode/lookover-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { COLOUR_READER_SOURCE, type Painted } from '../src/interaction/colour-in-page.js';
import { launchTestSession, type TestSession } from './helpers/session.js';

const BROWSER_TIMEOUT_MS = 30_000;
const NOT_A_COLOUR = 'not-a-colour';

interface Read {
  painted: Painted | null;
  rgb: string | null;
}

describe('COLOUR_READER_SOURCE', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let browser: TestSession;
  let ipage: InstrumentedPage;

  beforeAll(async () => {
    browser = await launchTestSession();
    ipage = await browser.newPage();
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await ipage.close();
    await browser.close();
  }, BROWSER_TIMEOUT_MS);

  /** Reads each colour in turn through one reader, as an in-page source reads a page's colours. */
  function readInOrder(colours: readonly string[]): Promise<Read[]> {
    return ipage.page.evaluate(
      `(() => { const reader = (${COLOUR_READER_SOURCE})(); return ${JSON.stringify(colours)}.map((colour) => ({ painted: reader.paint(colour), rgb: reader.asRgb(colour) })); })()`,
    );
  }

  test('reads a colour it can paint', async () => {
    const [red] = await readInOrder(['rgb(255, 0, 0)']);

    expect(red).toEqual({ painted: { r: 255, g: 0, b: 0, a: 1 }, rgb: 'rgb(255, 0, 0)' });
  });

  test('is null for a colour the canvas rejects, and never repaints the colour read before it', async () => {
    const [, rejected] = await readInOrder(['rgb(255, 0, 0)', NOT_A_COLOUR]);

    expect(rejected).toEqual({ painted: null, rgb: null });
  });

  test('reads black, white and transparent, whatever it compares a rejected colour with', async () => {
    const read = await readInOrder(['rgb(0, 0, 0)', NOT_A_COLOUR, 'rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)']);

    expect(read).toEqual([
      { painted: { r: 0, g: 0, b: 0, a: 1 }, rgb: 'rgb(0, 0, 0)' },
      { painted: null, rgb: null },
      { painted: { r: 255, g: 255, b: 255, a: 1 }, rgb: 'rgb(255, 255, 255)' },
      { painted: { r: 0, g: 0, b: 0, a: 0 }, rgb: 'rgba(0, 0, 0, 0)' },
    ]);
  });
});
