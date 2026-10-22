import type { Finding } from '@jayslifecode/lookover-core';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { API_PATHS, EVIDENCE_PATH_PREFIX } from '../node/api';
import { initialState, type ReportState, reduce, withFindingsFile } from '../src/data/reduce';
import { findingsOnScreen } from '../src/data/selectors';
import { type PinPlacement, placePins } from '../src/screens/pins';
import { ScreensView } from '../src/screens/screens-view';
import { fixtureEvents, fixtureEvidenceText, fixtureFindings } from './fixture';

/*
 * The Screens view's tests run over the fixture run (3 screens of the bench: the dashboard, the login
 * page and the organisations list). jsdom loads no image and lays nothing out, so the screenshot's sizes
 * are stubbed: 1440 px wide as captured, shown 720 px wide. `fetch` answers the evidence files from the
 * fixture.
 */

export const STATE: ReportState = withFindingsFile(
  fixtureEvents().reduce(reduce, initialState()),
  fixtureFindings(),
);
export const DASHBOARD = '4a17c4d0a2';
export const LOGIN = '57682dba9d';
export const ORGANISATIONS = '38a8049145';
export const NATURAL_WIDTH = 1440;
export const NATURAL_HEIGHT = 1800;
export const SHOWN_WIDTH = 720;
const PIN_NAME = /^\d+\. /;
const SCREENSHOT_NAME = /^Screenshot of /;

export function stubImageSizes(): void {
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(NATURAL_WIDTH);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(NATURAL_HEIGHT);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this instanceof HTMLImageElement ? SHOWN_WIDTH : 0;
  });
}

/** `fetch` answering `/api/evidence/<path>` from the fixture run's evidence, else 404. */
export function stubEvidenceFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(API_PATHS.evidence)) return new Response('{}', { status: 404 });
    const path = `${EVIDENCE_PATH_PREFIX}${decodeURIComponent(url.slice(API_PATHS.evidence.length))}`;
    return new Response(fixtureEvidenceText(path), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function show(screenId: string | null, findingId: string | null = null, report: ReportState = STATE) {
  return <ScreensView report={report} screenId={screenId} findingId={findingId} />;
}

export function screenshot(): HTMLElement {
  return screen.getByRole('img', { name: SCREENSHOT_NAME });
}

export function queryScreenshot(): HTMLElement | null {
  return screen.queryByRole('img', { name: SCREENSHOT_NAME });
}

/** Fires the screenshot's `load`, as the browser does once it has the image. */
export function loadScreenshot(): void {
  const image = screenshot();
  act(() => {
    fireEvent.load(image);
  });
}

export function pinNames(): (string | null)[] {
  const pins = within(screen.getByRole('list', { name: 'Pinned findings' })).queryAllByRole('button', {
    name: PIN_NAME,
  });
  return pins.map((pin) => pin.getAttribute('aria-label'));
}

/** The pins the view should draw for `screenId` at the stubbed sizes. */
export function placementsOn(screenId: string): PinPlacement[] {
  const shown = { width: SHOWN_WIDTH, height: (NATURAL_HEIGHT * SHOWN_WIDTH) / NATURAL_WIDTH };
  return placePins(findingsOnScreen(STATE, screenId), NATURAL_WIDTH, SHOWN_WIDTH, shown);
}

export function pinButtons(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Pinned findings' })).getAllByRole('button');
}

export function stepFindingsOn(screenId: string): Finding[] {
  return findingsOnScreen(STATE, screenId).filter((finding) => finding.shape === 'step');
}

/** The state gallery's rows, once it has loaded `count` of them. */
export async function galleryRows(count: number): Promise<HTMLElement[]> {
  return vi.waitFor(() => {
    const rows = [...screen.getByRole('list', { name: 'Controls in each state' }).children] as HTMLElement[];
    expect(rows).toHaveLength(count);
    return rows;
  });
}

/** The value next to `term` in the scorecard. */
export function scoreOf(term: string): string | null {
  const card = screen.getByRole('region', { name: 'Scorecard' });
  return within(card).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? null;
}
