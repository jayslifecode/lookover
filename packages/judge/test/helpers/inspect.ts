import {
  defaultObservers,
  type Finding,
  type Lens,
  navigate,
  type OccurrenceFinding,
  type Screen,
  type StepFinding,
  type Timing,
} from '@jayslifecode/lookover-core';
import { DEFAULT_TEST_VIEWPORT, screenOf, type TestBed } from './session.js';

/** The id the inspected screens get, unless a test names another. */
export const SCREEN_ID = 'screen-1';
const TIMING: Timing = { settleMs: 500, navigationTimeoutMs: 15_000 };

/** What the crawl saw on a screen: the screen as captured and every candidate on it, worth-a-look included. */
export interface Inspected {
  screen: Screen;
  findings: Finding[];
}

/** Captures `path` on a fresh page of the bed's session as the crawl does, and runs the observers and `lens` on it. */
export async function inspectPage(
  bed: TestBed,
  lens: Lens,
  path: string,
  screenId: string = SCREEN_ID,
): Promise<Inspected> {
  const ipage = await bed.session.newIsolatedPage(DEFAULT_TEST_VIEWPORT);
  try {
    const observers = defaultObservers(bed.ctx);
    for (const observer of observers) observer.attach(ipage);
    const failure = await navigate(ipage.page, `${bed.url}${path}`, TIMING);
    if (failure !== null) throw new Error(`could not load ${path}: ${failure}`);
    const screen = await screenOf(ipage, screenId, DEFAULT_TEST_VIEWPORT);
    let findings: Finding[] = [];
    for (const observer of observers) {
      const collected = await observer.collect(screen);
      findings = [...findings, ...collected.findings, ...collected.worthALook];
    }
    const inspection = await lens.inspect({
      ctx: bed.ctx,
      screen,
      ipage,
      viewports: [DEFAULT_TEST_VIEWPORT],
      interaction: 'full',
      deadline: Number.POSITIVE_INFINITY,
    });
    return { screen, findings: [...findings, ...inspection.findings, ...inspection.worthALook] };
  } finally {
    await ipage.close();
  }
}

export function stepFindingOf({ findings }: Inspected, ruleId: string): StepFinding {
  const found = findings.find((finding) => finding.rule.id === ruleId);
  if (found?.shape !== 'step') throw new Error(`no ${ruleId} step finding`);
  return found;
}

export function occurrenceFindingOf({ findings }: Inspected, ruleId: string): OccurrenceFinding {
  const found = findings.find((finding) => finding.rule.id === ruleId);
  if (found?.shape !== 'occurrence') throw new Error(`no ${ruleId} occurrence finding`);
  return found;
}
