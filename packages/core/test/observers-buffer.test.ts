import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { describe, expect, test } from 'vitest';
import { NavigationBuffer } from '../src/observers/buffer.js';

/*
 * The buffer only listens to a page's `request` and `framenavigated` events, so a stand-in page can
 * raise them in exactly the order a real one did, including the orders a browser only produces in a
 * race (a same-document navigation of the page being left while the next document loads).
 */

const CAPACITY = 10;
const REPORTS = 'http://localhost:3123/reports';
const SETTINGS = 'http://localhost:3123/settings';
const LOGIN = 'http://localhost:3123/login';

interface StandInFrame {
  url(): string;
  parentFrame(): StandInFrame | null;
}

function mainFrame(url: string): StandInFrame {
  return { url: () => url, parentFrame: () => null };
}

function childFrame(url: string): StandInFrame {
  return { url: () => url, parentFrame: () => mainFrame(REPORTS) };
}

function documentRequest(url: string, frame: StandInFrame = mainFrame(url)) {
  return { url: () => url, isNavigationRequest: () => true, frame: () => frame };
}

/** A buffer attached to a stand-in page, and the events that page can raise. */
function bufferOnPage() {
  const page = new EventEmitter();
  const buffer = new NavigationBuffer<string>(CAPACITY);
  buffer.attach(page as unknown as Page);
  return {
    buffer,
    requestDocument: (url: string, frame?: StandInFrame) => page.emit('request', documentRequest(url, frame)),
    navigated: (frame: StandInFrame) => page.emit('framenavigated', frame),
  };
}

describe('NavigationBuffer', () => {
  test('forgets what the page left behind once the requested document commits', () => {
    const { buffer, requestDocument, navigated } = bufferOnPage();
    buffer.record('logged by /reports');

    requestDocument(SETTINGS);
    buffer.record('logged by /reports while /settings loads');
    navigated(mainFrame(SETTINGS));
    buffer.record('logged by /settings');

    expect(buffer.drain().entries).toEqual(['logged by /settings']);
  });

  test('does not take a same-document navigation of the page being left for the commit', () => {
    // The order a Next.js dev page gave on the bench: its router replaces its own history entry once it
    // has hydrated, and its mount effects log, after the crawler has asked for the next screen.
    const { buffer, requestDocument, navigated } = bufferOnPage();

    requestDocument(SETTINGS);
    navigated(mainFrame(REPORTS));
    buffer.record('logged by /reports after its router replaced its history entry');
    navigated(mainFrame(SETTINGS));
    buffer.record('logged by /settings');

    expect(buffer.drain().entries).toEqual(['logged by /settings']);
  });

  test('keeps what a page logged around its own same-document navigations when no document was asked for', () => {
    const { buffer, navigated } = bufferOnPage();

    buffer.record('before the hash changed');
    navigated(mainFrame(`${REPORTS}#summary`));
    buffer.record('after the hash changed');

    expect(buffer.drain().entries).toEqual(['before the hash changed', 'after the hash changed']);
  });

  test('commits a document whose address has a hash, which its request does not carry', () => {
    const { buffer, requestDocument, navigated } = bufferOnPage();
    buffer.record('logged by the page being left');

    requestDocument(SETTINGS);
    navigated(mainFrame(`${SETTINGS}#time-zone`));

    expect(buffer.drain().entries).toEqual([]);
  });

  test('commits the last hop of a redirect, where the document lands', () => {
    const { buffer, requestDocument, navigated } = bufferOnPage();
    buffer.record('logged by the page being left');

    requestDocument(SETTINGS);
    requestDocument(LOGIN);
    navigated(mainFrame(LOGIN));

    expect(buffer.drain().entries).toEqual([]);
  });

  test('keeps the entry about the requested document for the page it belongs to', () => {
    const { buffer, requestDocument, navigated } = bufferOnPage();

    requestDocument(SETTINGS);
    buffer.recordDocument('GET /settings answered 500');
    navigated(mainFrame(REPORTS));
    navigated(mainFrame(SETTINGS));

    expect(buffer.drain().entries).toEqual(['GET /settings answered 500']);
  });

  test("is not emptied when one of the page's frames loads a document", () => {
    const { buffer, requestDocument, navigated } = bufferOnPage();
    buffer.record('logged by /reports');

    requestDocument(`${REPORTS}/frame`, childFrame(`${REPORTS}/frame`));
    navigated(childFrame(`${REPORTS}/frame`));

    expect(buffer.drain().entries).toEqual(['logged by /reports']);
  });
});
