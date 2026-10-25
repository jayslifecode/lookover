import type { BrowserSession, DecisionsFile, RunContext } from '@jayslifecode/lookover-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createDecisionsOnlyJudge } from '../src/index.js';
import {
  candidatesFile,
  errorOn,
  eventsOf,
  focusOn,
  NO_DECISIONS,
  NOW,
  nextEvent,
  openRun,
  screenAt,
} from './helpers/pipeline-bed.js';

const SETTINGS = screenAt('screen-settings', '/settings');
const PROFILE = screenAt('screen-profile', '/profile');
const NOTE = 'The outline is on the wrapper';

/** A session that fails the test the moment anything on it is used: nothing may be reproduced. */
const UNTOUCHABLE_SESSION = new Proxy({} as BrowserSession, {
  get: (_target, property) => {
    throw new Error(`The decisions-only judge used the session (${String(property)})`);
  },
});

function decide(...ids: string[]): DecisionsFile {
  return {
    version: 1,
    decisions: Object.fromEntries(
      ids.map((id) => [id, { status: 'intended' as const, at: NOW, note: NOTE }]),
    ),
  };
}

describe('createDecisionsOnlyJudge', () => {
  let ctx: RunContext;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ ctx, close } = await openRun());
  });

  afterEach(async () => {
    await close();
  });

  test('logs an intended finding as judged at once, and drains it into intended; the other candidates stay as measured', async () => {
    const decided = focusOn(SETTINGS, '#decided');
    const other = focusOn(SETTINGS);
    const judge = createDecisionsOnlyJudge({ ctx, decisions: decide(decided.id), now: () => NOW });
    const firstJudged = nextEvent(ctx, 'finding.judged');

    judge.attach(UNTOUCHABLE_SESSION);
    judge.onScreenInspected(SETTINGS, [decided, other], []);

    expect((await firstJudged).finding).toMatchObject({
      id: decided.id,
      status: 'intended',
      judgement: { decidedBy: 'user', of: 0, attempts: [], note: NOTE, judgedAt: NOW },
    });
    const { file } = await judge.drain(candidatesFile(ctx, [decided, other]));
    expect(file.findings).toEqual([other]);
    expect(file.intended).toEqual([
      {
        ...decided,
        status: 'intended',
        judgement: expect.objectContaining({ decidedBy: 'user', note: NOTE, judgedAt: NOW }),
      },
    ]);
    expect(file.rejected).toEqual([]);
    expect(file.judge).toBeNull();
    expect(file.environment).toBeNull();
    expect((await eventsOf(ctx, 'finding.judged')).map(({ finding }) => finding.id)).toEqual([decided.id]);
  });

  test('logs an intended occurrence finding once, however many screens yield it, and drains the merged one', async () => {
    const message = 'Report locale missing';
    const judge = createDecisionsOnlyJudge({
      ctx,
      decisions: decide(errorOn(message, [SETTINGS]).id),
      now: () => NOW,
    });

    judge.attach(UNTOUCHABLE_SESSION);
    judge.onScreenInspected(SETTINGS, [errorOn(message, [SETTINGS])], []);
    judge.onScreenInspected(PROFILE, [errorOn(message, [PROFILE])], []);
    const merged = errorOn(message, [SETTINGS, PROFILE]);
    const { file } = await judge.drain(candidatesFile(ctx, [merged]));

    expect(file.findings).toEqual([]);
    expect(file.intended).toHaveLength(1);
    expect(file.intended[0]).toMatchObject({
      id: merged.id,
      status: 'intended',
      occurrences: merged.occurrences,
    });
    expect(await eventsOf(ctx, 'finding.judged')).toHaveLength(1);
  });

  test('keeps the intended findings the file already has, before the new ones', async () => {
    const decided = focusOn(SETTINGS, '#decided');
    const earlier = { ...focusOn(PROFILE), status: 'intended' as const };
    const judge = createDecisionsOnlyJudge({ ctx, decisions: decide(decided.id), now: () => NOW });

    judge.onScreenInspected(SETTINGS, [decided], []);
    const { file } = await judge.drain({ ...candidatesFile(ctx, [decided]), intended: [earlier] });

    expect(file.intended.map(({ id }) => id)).toEqual([earlier.id, decided.id]);
  });

  test('without decisions, drains the file as it is, unjudged', async () => {
    const findings = [focusOn(SETTINGS), errorOn('boom', [SETTINGS])];
    const worthALook = [focusOn(PROFILE, '#hover')];
    const judge = createDecisionsOnlyJudge({ ctx, decisions: NO_DECISIONS });
    const input = { ...candidatesFile(ctx, findings), worthALook, skipped: [{ reason: 'gone', count: 1 }] };
    const snapshot = structuredClone(input);

    judge.attach(UNTOUCHABLE_SESSION);
    judge.onScreenInspected(SETTINGS, findings, worthALook);
    const { file } = await judge.drain(input);

    expect(file).toEqual({ ...snapshot, judge: null, environment: null });
    expect(input).toEqual(snapshot);
    expect(await eventsOf(ctx, 'finding.judged')).toEqual([]);
  });

  test('a decision on a worth-a-look entry leaves it where it is, as the pipeline does', async () => {
    const hover = focusOn(PROFILE, '#hover');
    const judge = createDecisionsOnlyJudge({ ctx, decisions: decide(hover.id) });

    judge.onScreenInspected(PROFILE, [], [hover]);
    const { file } = await judge.drain({ ...candidatesFile(ctx, []), worthALook: [hover] });

    expect(file.worthALook).toEqual([hover]);
    expect(file.intended).toEqual([]);
  });

  test('says once, when attached, that the judge was turned off, as the pipeline says it has no key', async () => {
    const judge = createDecisionsOnlyJudge({ ctx, decisions: NO_DECISIONS, now: () => NOW });

    judge.attach(UNTOUCHABLE_SESSION);
    judge.attach(UNTOUCHABLE_SESSION);
    await judge.drain(candidatesFile(ctx, []));

    expect(await eventsOf(ctx, 'judge.unavailable')).toMatchObject([
      { reason: 'disabled', message: 'The judge was turned off with --no-judge' },
    ]);
  });
});
