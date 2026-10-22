import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { type FixtureServer, serveFixture } from '@jayslifecode/lookover-test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BrowserSession } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import type { Judge } from '../src/findings/judge.js';
import { FINDINGS_FILE } from '../src/findings/persist.js';
import type { Finding, FindingsFile, Judgement, JudgeTotals } from '../src/findings/types.js';
import type { Screen } from '../src/map/types.js';
import type { Observer } from '../src/observers/types.js';
import { runReview } from '../src/run/engine.js';
import type { RunEvent } from '../src/run/events.js';
import { createRun, type RunContext } from '../src/run/run-context.js';
import { RunLog } from '../src/run/run-log.js';
import { DESKTOP, occurrence, occurrenceFinding, stepFinding } from './fixtures/findings.js';

const SITE_DIR = fileURLToPath(new URL('./fixtures/site', import.meta.url));
const BROWSER_TIMEOUT_MS = 60_000;
/** `/` is the home page, whose one link leads to a second screen of the app. */
const SCREENS = 2;
const REPEATED_ERROR_ID = 'console-error-1';
/** Long enough that a `writeFindings` not waiting for the drain would write first. */
const DRAIN_DELAY_MS = 200;
const JUDGED_AT = '2026-10-22T10:00:00.000Z';
const TOTALS: JudgeTotals = {
  model: 'claude-sonnet-5-5',
  calls: 2,
  cacheHits: 1,
  usage: { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  estimatedUsd: 0.005,
  unavailable: null,
};

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

/** On every screen: a step finding of its own, the same console error, and one worth-a-look entry. */
function seeingObserver(): Observer {
  return {
    name: 'fake',
    attach: () => undefined,
    collect: async (screen) => ({
      findings: [
        stepFinding({ id: `step-${screen.id}`, screenId: screen.id }),
        occurrenceFinding({
          id: REPEATED_ERROR_ID,
          occurrences: [occurrence(screen.id, null, { route: screen.route, url: screen.url })],
        }),
      ],
      worthALook: [stepFinding({ id: `look-${screen.id}`, screenId: screen.id })],
      evidence: [],
    }),
  };
}

function judgement(status: 'confirmed' | 'rejected'): Judgement {
  return {
    reproduced: status === 'confirmed' ? 3 : 1,
    of: 3,
    attempts: [],
    decidedBy: 'harness',
    attribution: status === 'confirmed' ? 'product-defect' : 'timing',
    oracle: null,
    note: null,
    model: null,
    usage: null,
    estimatedUsd: null,
    cached: false,
    droppedOccurrences: [],
    environment: null,
    judgedAt: JUDGED_AT,
  };
}

/** The step findings confirmed, the repeated error rejected, with totals and an environment. */
function judged(file: FindingsFile): FindingsFile {
  const decided = file.findings.map((finding): Finding => {
    const status = finding.shape === 'step' ? 'confirmed' : 'rejected';
    return { ...finding, status, judgement: judgement(status) };
  });
  return {
    ...file,
    findings: decided.filter((finding) => finding.status === 'confirmed'),
    rejected: decided.filter((finding) => finding.status === 'rejected'),
    judge: TOTALS,
    environment: {
      browser: 'chromium',
      os: 'test',
      node: process.version,
      lookover: '0.0.0-test',
      viewport: DESKTOP,
    },
  };
}

interface HandedScreen {
  screenId: string;
  findings: Finding[];
  worthALook: Finding[];
  /** The run log already held this screen's `screen.inspected` when the judge was handed it. */
  afterInspected: boolean;
}

/** A judge that records what it is handed and drains by `judged`, opening a page on the session first. */
function recordingJudge(ctx: RunContext): {
  judge: Judge;
  calls: string[];
  screens: HandedScreen[];
  drained: FindingsFile[];
} {
  const calls: string[] = [];
  const screens: HandedScreen[] = [];
  const drained: FindingsFile[] = [];
  let session: BrowserSession | null = null;
  const judge: Judge = {
    attach: (attached) => {
      session = attached;
      calls.push('attach');
    },
    onScreenInspected: (screen: Screen, findings, worthALook) => {
      calls.push(`screen ${screen.id}`);
      const logged = readFileSync(ctx.log.file, 'utf8');
      screens.push({
        screenId: screen.id,
        findings: [...findings],
        worthALook: [...worthALook],
        afterInspected: logged.includes(`"type":"screen.inspected","screenId":"${screen.id}"`),
      });
    },
    drain: async (file) => {
      calls.push('drain');
      drained.push(file);
      if (session === null) throw new Error('drained before a session was attached');
      // The session is still open: a page opens on it.
      const ipage = await session.newIsolatedPage(DESKTOP);
      await ipage.close();
      await delay(DRAIN_DELAY_MS);
      return { file: judged(file) };
    },
  };
  return { judge, calls, screens, drained };
}

describe('runReview with a judge', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let fixture: FixtureServer;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lookover-engine-judge-'));
    fixture = await serveFixture(SITE_DIR, { '/': (_req, _res, serveStatic) => serveStatic('/home.html') });
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }, BROWSER_TIMEOUT_MS);

  async function newProject(): Promise<{ cwd: string; ctx: RunContext }> {
    const cwd = await mkdtemp(join(workDir, 'project-'));
    const config = configSchema.parse({ baseUrl: fixture.url, interaction: 'safe', maxScreens: SCREENS });
    return { cwd, ctx: await createRun({ cwd, config }) };
  }

  async function onDisk(ctx: RunContext): Promise<FindingsFile> {
    return JSON.parse(await readFile(join(ctx.dir, FINDINGS_FILE), 'utf8')) as FindingsFile;
  }

  test('the engine hands every inspected screen to the judge and writes the drained file', async () => {
    const { cwd, ctx } = await newProject();
    const { judge, calls, screens, drained } = recordingJudge(ctx);

    const result = await runReview(ctx, { cwd, observers: [seeingObserver()], judge });

    const events = await RunLog.read(ctx.log.file);
    const inspected = eventsOf(events, 'screen.inspected').map(({ screenId }) => screenId);
    expect(inspected).toHaveLength(SCREENS);
    expect(calls).toEqual(['attach', ...inspected.map((id) => `screen ${id}`), 'drain']);
    expect(screens.map(({ screenId }) => screenId)).toEqual(inspected);
    for (const screen of screens) {
      expect(screen.afterInspected).toBe(true);
      // The screen's own yield, before the run-level merge: the repeated error has this screen alone.
      const error = screen.findings.find(({ id }) => id === REPEATED_ERROR_ID);
      expect(error?.shape === 'occurrence' && error.occurrences.map(({ screenId }) => screenId)).toEqual([
        screen.screenId,
      ]);
      expect(screen.worthALook.map(({ id }) => id)).toEqual([`look-${screen.screenId}`]);
    }
    const [candidates] = drained;
    const mergedError = candidates?.findings.find(({ id }) => id === REPEATED_ERROR_ID);
    expect(mergedError?.shape === 'occurrence' && mergedError.occurrences).toHaveLength(SCREENS);
    const expected = judged(candidates as FindingsFile);
    expect(result.findings).toEqual(expected);
    expect(await onDisk(ctx)).toEqual(expected);
    const [finished] = eventsOf(events, 'run.finished');
    expect(finished).toMatchObject({
      confirmed: SCREENS,
      rejected: 1,
      intended: 0,
      worthALook: SCREENS,
      judge: TOTALS,
    });
  });

  test('without a judge the file is the candidates, version 2, judge null', async () => {
    const { cwd, ctx } = await newProject();

    const result = await runReview(ctx, { cwd, observers: [seeingObserver()] });

    const file = await onDisk(ctx);
    expect(file).toEqual(result.findings);
    expect(file).toMatchObject({ version: 2, rejected: [], intended: [], judge: null, environment: null });
    // A step finding per screen and the one repeated error, merged.
    expect(file.findings).toHaveLength(SCREENS + 1);
    expect(file.findings.every(({ status, judgement }) => status === 'candidate' && judgement === null)).toBe(
      true,
    );
    const [finished] = eventsOf(await RunLog.read(ctx.log.file), 'run.finished');
    expect(finished).toMatchObject({ confirmed: 0, rejected: 0, intended: 0, judge: null });
  });
});
