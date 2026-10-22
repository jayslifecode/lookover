import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Attempt,
  type BrowserSession,
  configSchema,
  createRun,
  type DecisionsFile,
  type Environment,
  type Finding,
  type FindingsFile,
  type OccurrenceFinding,
  occurrenceFinding,
  type ReproductionTarget,
  type RunContext,
  type RunEvent,
  RunLog,
  type Screen,
  type StepFinding,
  stepFinding,
  type Viewport,
} from '@jayslifecode/lookover-core';
import type { HarnessOptions, PipelineHarness, ScreenBatch } from '../../src/index.js';
import { REPRODUCTION_ATTEMPTS, targetKey } from '../../src/index.js';
import {
  CONSOLE_ERROR,
  CREATED_AT,
  ENVIRONMENT,
  FOCUS_OBSERVED,
  FOCUS_VISIBLE,
  VIEWPORT,
} from './bundle-fixtures.js';

export const NOW = '2026-10-22T10:00:00.000Z';
export const NO_DECISIONS: DecisionsFile = { version: 1, decisions: {} };
const BASE_URL = 'http://localhost:3123';

/**
 * Never used: the pipeline hands the session to the harness factory, and every test stubs the harness.
 * A real one would need a browser.
 */
export const UNUSED_SESSION = {} as BrowserSession;

/** A run in a fresh temporary project: its log, its evidence and its `.lookover/` directory. */
export async function openRun(): Promise<{ ctx: RunContext; close: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'lookover-pipeline-'));
  const ctx = await createRun({
    cwd,
    config: configSchema.parse({ baseUrl: BASE_URL, interaction: 'safe' }),
  });
  return { ctx, close: () => rm(cwd, { recursive: true, force: true }) };
}

/** Where the stub harness says a finding was judged: the test environment at `viewport`. */
export function environmentAt(viewport: Viewport): Environment {
  return { ...ENVIRONMENT, viewport: { ...viewport } };
}

export function screenAt(id: string, route: string): Screen {
  return {
    id,
    url: `${BASE_URL}${route}`,
    route,
    title: route,
    status: 'captured',
    error: null,
    viewport: VIEWPORT,
    screenshot: null,
    elements: [],
    forms: [],
    tokens: [],
    links: [],
    redirectedFrom: null,
    discoveredFrom: null,
    capturedAt: CREATED_AT,
  };
}

/** A missing focus ring on the control `selector` of `screen`. */
export function focusOn(screen: Screen, selector = '#save'): StepFinding {
  return stepFinding({
    rule: FOCUS_VISIBLE,
    screen,
    target: {
      selector,
      role: 'button',
      name: 'Save',
      componentName: null,
      signature: 'button.btn',
      box: { x: 24, y: 480, width: 96, height: 36 },
    },
    trace: {
      route: screen.route,
      url: screen.url,
      viewport: VIEWPORT,
      steps: [
        { kind: 'navigate', url: screen.url },
        { kind: 'force-state', selector, state: 'focus' },
      ],
    },
    observed: FOCUS_OBSERVED,
    evidence: [],
    createdAt: CREATED_AT,
  });
}

/** The console error `message` as each of `screens` yielded it: the same id, an occurrence per screen. */
export function errorOn(message: string, screens: readonly Screen[]): OccurrenceFinding {
  return occurrenceFinding({
    rule: CONSOLE_ERROR,
    key: message,
    occurrences: screens.map((screen) => ({
      screenId: screen.id,
      route: screen.route,
      url: screen.url,
      viewport: VIEWPORT,
      selector: null,
      measured: { message, count: 1 },
    })),
    observed: `logged "${message}"`,
    evidence: [],
    createdAt: CREATED_AT,
  });
}

/** `REPRODUCTION_ATTEMPTS` attempts at `target`, the first `reproduced` of them reproducing it. */
export function attemptsAt(target: ReproductionTarget, reproduced: number): Attempt[] {
  const occurrence =
    'occurrence' in target
      ? {
          screenId: target.occurrence.screenId,
          selector: target.occurrence.selector,
          viewport: target.occurrence.viewport.name,
        }
      : null;
  return Array.from({ length: REPRODUCTION_ATTEMPTS }, (_, index) => ({
    index: index + 1,
    occurrence,
    reproduced: index < reproduced,
    observed: index < reproduced ? target.finding.observed : null,
    skipped: null,
    durationMs: 400,
    evidence: [],
  }));
}

/** What the harness hands back for `batch` when each target reproduces `reproducedOf(target)` times. */
export function attemptsFor(
  batch: ScreenBatch,
  reproducedOf: (target: ReproductionTarget) => number,
): Map<string, Attempt[]> {
  return new Map(
    batch.targets.map((target) => [targetKey(target), attemptsAt(target, reproducedOf(target))]),
  );
}

export interface StubHarness {
  /** The pipeline's `harness` option. */
  factory: (options: HarnessOptions) => PipelineHarness;
  /** Every batch the pipeline asked to reproduce, in the order it asked. */
  batches: ScreenBatch[];
  /** How many of them have been answered. */
  answered: () => number;
}

/** A harness that answers each batch with `script`, and records what it was asked. */
export function stubHarness(
  script: (batch: ScreenBatch) => Map<string, Attempt[]> | Promise<Map<string, Attempt[]>>,
): StubHarness {
  const batches: ScreenBatch[] = [];
  let answered = 0;
  const harness: PipelineHarness = {
    reproduce: async (batch) => {
      batches.push(batch);
      const attempts = await script(batch);
      answered += 1;
      return attempts;
    },
    environment: environmentAt,
  };
  return { factory: () => harness, batches, answered: () => answered };
}

/** The candidates file the engine drains: `findings` as the run merged them. */
export function candidatesFile(ctx: RunContext, findings: readonly Finding[]): FindingsFile {
  return {
    version: 2,
    runId: ctx.runId,
    createdAt: CREATED_AT,
    findings: [...findings],
    worthALook: [],
    skipped: [],
    rejected: [],
    intended: [],
    judge: null,
    environment: null,
  };
}

export async function eventsOf<T extends RunEvent['type']>(
  ctx: RunContext,
  type: T,
): Promise<Extract<RunEvent, { type: T }>[]> {
  const events = await RunLog.read(ctx.log.file);
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

/** Resolves with the first event of `type` appended from now on. */
export function nextEvent<T extends RunEvent['type']>(
  ctx: RunContext,
  type: T,
): Promise<Extract<RunEvent, { type: T }>> {
  return new Promise((resolve) => {
    const stop = ctx.log.subscribe((event) => {
      if (event.type !== type) return;
      stop();
      resolve(event as Extract<RunEvent, { type: T }>);
    });
  });
}

export interface Gate {
  promise: Promise<void>;
  open: () => void;
}

/** A promise the test resolves when it chooses. */
export function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
