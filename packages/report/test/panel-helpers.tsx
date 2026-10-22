import type { Finding, StepFinding } from '@jayslifecode/lookover-core';
import { screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { API_PATHS, EVIDENCE_PATH_PREFIX } from '../node/api';
import { fixtureEvidenceText } from './fixture';
import { STATE } from './screens-helpers';

/*
 * What the finding panel's tests share: the fixture's findings by id, and a `fetch` that answers like
 * the report server — evidence from the fixture run, and the two POSTs, each held until the test lets
 * it answer (so the panel can be seen while a request is in flight).
 */

export const KEYBOARD = 'da77d007d373';
export const INTENDED = 'e9839cc1b237';
export const OVERFLOW = 'e930b1d782be';

export function fixtureFinding(id: string): Finding {
  const finding = STATE.judged.get(id);
  if (finding === undefined) throw new Error(`The fixture run has no finding ${id}`);
  return finding;
}

export function fixtureStep(id: string): StepFinding {
  const finding = fixtureFinding(id);
  if (finding.shape !== 'step') throw new Error(`The fixture finding ${id} is not a step finding`);
  return finding;
}

export interface HeldPost {
  readonly body: unknown;
  /** Lets the request answer; the test then waits for what the panel shows. */
  answer(status: number, body: unknown): void;
}

export interface Server {
  readonly fetch: ReturnType<typeof vi.fn>;
  /** The POSTs to `path` so far, oldest first. */
  posts(path: string): HeldPost[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function stubServer(): Server {
  const held = new Map<string, HeldPost[]>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      let resolve: (response: Response) => void = () => undefined;
      const answered = new Promise<Response>((done) => {
        resolve = done;
      });
      const post: HeldPost = {
        body: JSON.parse(String(init.body)),
        answer: (status, body) => resolve(json(status, body)),
      };
      held.set(url, [...(held.get(url) ?? []), post]);
      return answered;
    }
    if (!url.startsWith(API_PATHS.evidence)) return json(404, { error: `No ${url}` });
    const path = `${EVIDENCE_PATH_PREFIX}${decodeURIComponent(url.slice(API_PATHS.evidence.length))}`;
    return new Response(fixtureEvidenceText(path), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetch: fetchMock, posts: (path) => held.get(path) ?? [] };
}

/** The panel showing the finding titled `title`. */
export function panelFor(title: string): HTMLElement {
  return screen.getByRole('complementary', { name: title });
}

/** The value beside `term` in a key-value list inside `root`. */
export function factOf(root: HTMLElement, term: string): string | null {
  return within(root).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? null;
}

export function stubClipboard(writeText: (text: string) => Promise<void>) {
  const clipboard = { writeText: vi.fn(writeText) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  return clipboard;
}

/** jsdom has no modal dialogs: `showModal` and `close` only toggle `open`, and `close` fires `close`. */
export function stubDialog(): void {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
}

export function unstubDialog(): void {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  Reflect.deleteProperty(navigator, 'clipboard');
}
