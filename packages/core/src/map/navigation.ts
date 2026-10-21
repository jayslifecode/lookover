import type { Page } from 'playwright';
import { LookoverError } from '../errors.js';

export interface Timing {
  settleMs: number;
  navigationTimeoutMs: number;
}

const FONTS_READY_TIMEOUT_MS = 2_000;
/** `about:blank` commits in milliseconds; this only bounds a page that has stopped responding. */
const BLANK_PAGE_TIMEOUT_MS = 5_000;
const BLANK_PAGE = 'about:blank';
const BROWSER_ERROR_PAGE_PREFIX = 'chrome-error://';

/** Loads `url` and lets it settle; returns why the navigation failed, or `null`. A `LookoverError` is rethrown. */
export async function navigate(page: Page, url: string, timing: Timing): Promise<string | null> {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: timing.navigationTimeoutMs });
  } catch (error) {
    if (error instanceof LookoverError) {
      throw error;
    }
    return describeError(error);
  }
  await settle(page, timing.settleMs);
  return landingFailure(page.url());
}

/**
 * Best effort, never throws: a page that holds a connection open (server-sent events, polling) never
 * goes quiet, and one that navigates itself while its fonts load destroys the context the wait runs
 * in. Whatever the page then is, the capture reads it, and fails the screen if it cannot.
 */
async function settle(page: Page, settleMs: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => undefined);
  await atMost(FONTS_READY_TIMEOUT_MS, page.evaluate(waitForFonts));
}

/** Runs in the page. */
function waitForFonts(): Promise<void> {
  return document.fonts.ready.then(() => undefined);
}

/** Waits for `task` until it settles (either way) or `ms` have passed. */
async function atMost(ms: number, task: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([task.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A navigation that did not throw can still have gone nowhere: the session sends a frame that left
 * the allowed hosts to `about:blank`, and Chromium shows some network failures as an error page.
 */
function landingFailure(landed: string): string | null {
  if (landed === BLANK_PAGE) {
    return `ended on ${BLANK_PAGE}, where the session sends pages that leave the allowed hosts`;
  }
  if (landed.startsWith(BROWSER_ERROR_PAGE_PREFIX)) {
    return `ended on the browser error page ${landed}`;
  }
  return null;
}

/**
 * Leaves the page on `about:blank` with nothing in flight. A failed page can still be busy: Chromium
 * commits its error page for a failed navigation only after `goto` has thrown, and Playwright calls a
 * navigation interrupted as soon as another document commits while the interrupted one still commits
 * after it. Either would interrupt the next screen's navigation, so this asks for `about:blank` and,
 * when that request was interrupted, waits until it is the page, which puts every earlier commit
 * behind it. A dead page has nothing left to commit and would never get there, so it is not waited
 * on. Best effort: if the page cannot get there, the next navigation reports its own failure.
 */
export async function settleOnBlankPage(page: Page, isDead: () => boolean): Promise<void> {
  const options = { timeout: BLANK_PAGE_TIMEOUT_MS };
  const hasLanded = await page.goto(BLANK_PAGE, options).then(
    () => true,
    () => false,
  );
  if (hasLanded || isDead()) {
    return;
  }
  await page.waitForURL((url) => url.href === BLANK_PAGE, options).catch(() => undefined);
}

/** The first line of the error's message: Playwright appends a multi-line call log. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  return firstLine === '' ? 'unknown error' : firstLine;
}
