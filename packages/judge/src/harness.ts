import {
  type Attempt,
  type BrowserSession,
  describeError,
  type Environment,
  type EvidenceItem,
  extractElements,
  type InstrumentedPage,
  type Lens,
  type LensContext,
  LookoverError,
  navigate,
  type Observer,
  type ObserverResult,
  PER_SCREEN_BUDGET_MS,
  type Reproduction,
  type ReproductionTarget,
  type RunContext,
  reproduceObservation,
  type Screen,
  type Timing,
  type Viewport,
} from '@jayslifecode/lookover-core';
import type { ScreenBatch } from './batch.js';
import { REPRODUCTION_ATTEMPTS } from './constants.js';
import { captureEnvironment } from './environment.js';

type Page = InstrumentedPage['page'];

export interface HarnessOptions {
  session: BrowserSession;
  ctx: RunContext;
  lenses: readonly Lens[];
  /** Fresh observers for each attempt's page (the crawl's own observers belong to the crawl page). */
  observers: () => readonly Observer[];
  /** `config.viewports`. */
  viewports: readonly Viewport[];
  interaction: 'full' | 'safe';
  /** Lookover's own version, recorded in every environment. */
  lookoverVersion: string;
  /** Fresh contexts per batch; default `REPRODUCTION_ATTEMPTS`. */
  attempts?: number;
  /**
   * Loads `url` on an attempt's page and throws when it cannot. By default core's `navigate`, with the
   * crawl's timing, and a navigation it reports as failed throws.
   */
  navigate?: (page: Page, url: string) => Promise<unknown>;
}

/** A target's attempts, looked up by the target itself. */
export interface AttemptsByTarget {
  get(target: ReproductionTarget): Attempt[];
}

/** The crawl's own defaults (`CrawlOptions`), so an attempt's page settles as the captured one did. */
const REPLAY_TIMING: Timing = { settleMs: 800, navigationTimeoutMs: 15_000 };
const OBSERVERS = 'observers';
const ERROR_SKIP_PREFIX = 'error:';

/** How one target's measurement went in one attempt, before it is recorded. */
interface Outcome {
  target: ReproductionTarget;
  reproduction: Reproduction;
  durationMs: number;
}

interface Recorded {
  key: string;
  attempt: Attempt;
}

/** Where a target falls in an attempt's measuring order: observers first, then by lens, then by rule. */
interface Rank {
  lens: number;
  rule: number;
}

/**
 * Measures candidates again, each batch of one screen in `attempts` fresh browser contexts one after the
 * other. One attempt: a page in a new isolated context, fresh observers attached to it, the screen's URL
 * loaded, its elements extracted again, then every target measured on that one load (see
 * `inMeasuringOrder`) by the lens that reported it (`finding.source`) or, for an observer finding, by
 * `reproduceObservation`; the context is closed whatever happened. Every target's attempt is stored as
 * `reproduction-<findingId>` JSON evidence (the attempt, the target's key, the URL, the reproduction and
 * the environment), which leads the attempt's evidence, followed by the reproduction's own.
 *
 * A thrown `LookoverError` is the run's failure and propagates. Any other error fails what it stopped:
 * while one target is measured, that target's attempt; while the context is opened, the page loaded, its
 * elements extracted or the context closed, every target's attempt; either way as not reproduced, with
 * `skipped: 'error:<first line of the message>'`, and the other attempts still run.
 */
export class Harness {
  private readonly attempts: number;
  private readonly navigate: (page: Page, url: string) => Promise<unknown>;

  constructor(private readonly options: HarnessOptions) {
    const attempts = options.attempts ?? REPRODUCTION_ATTEMPTS;
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError(`A reproduction needs a whole number of attempts above 0, not ${attempts}`);
    }
    this.attempts = attempts;
    this.navigate = options.navigate ?? navigateOrFail;
  }

  /** Runs `attempts` fresh contexts for the batch's screen, each measuring every target once. */
  async reproduce(batch: ScreenBatch): Promise<Map<string, Attempt[]>> {
    const targets = uniqueTargets(batch.targets);
    const [first] = targets;
    if (first === undefined) return new Map();
    const url = urlOf(first);
    const order = inMeasuringOrder(targets, this.options.lenses);
    let recorded: Recorded[] = [];
    for (let index = 1; index <= this.attempts; index += 1) {
      const outcomes = await this.attempt(batch.screen, url, order);
      recorded = [...recorded, ...(await this.record(outcomes, index, url))];
    }
    return new Map(
      targets.map((target) => {
        const key = targetKey(target);
        return [key, recorded.filter((entry) => entry.key === key).map((entry) => entry.attempt)];
      }),
    );
  }

  environment(viewport: Viewport): Environment {
    return captureEnvironment(this.options.session, viewport, this.options.lookoverVersion);
  }

  private async attempt(
    screen: Screen,
    url: string,
    targets: readonly ReproductionTarget[],
  ): Promise<Outcome[]> {
    const startedAt = performance.now();
    try {
      return await this.inFreshContext(screen, url, targets, startedAt);
    } catch (error) {
      const reproduction = failedReproduction(error);
      const durationMs = Math.round(performance.now() - startedAt);
      return targets.map((target) => ({ target, reproduction, durationMs }));
    }
  }

  private async inFreshContext(
    screen: Screen,
    url: string,
    targets: readonly ReproductionTarget[],
    startedAt: number,
  ): Promise<Outcome[]> {
    const ipage = await this.options.session.newIsolatedPage(screen.viewport);
    try {
      const observers = this.options.observers();
      for (const observer of observers) observer.attach(ipage);
      const context = await this.load(ipage, screen, url);
      return await this.measureEach(
        targets,
        context,
        collectedOnce(observers),
        performance.now() - startedAt,
      );
    } finally {
      await ipage.close();
    }
  }

  /** The page at `url` with its elements extracted again, as a lens is handed a captured screen. */
  private async load(ipage: InstrumentedPage, screen: Screen, url: string): Promise<LensContext> {
    await this.navigate(ipage.page, url);
    const { elements } = await extractElements(ipage);
    const others = this.options.viewports.filter(({ name }) => name !== screen.viewport.name);
    return {
      ctx: this.options.ctx,
      screen: { ...screen, elements },
      ipage,
      viewports: [screen.viewport, ...others],
      interaction: this.options.interaction,
      deadline: performance.now() + PER_SCREEN_BUDGET_MS,
    };
  }

  /** Each target in turn on the one load; a target's duration counts the load it needed and its own measure. */
  private async measureEach(
    targets: readonly ReproductionTarget[],
    context: LensContext,
    observers: readonly Observer[],
    loadMs: number,
  ): Promise<Outcome[]> {
    let outcomes: Outcome[] = [];
    for (const target of targets) {
      const startedAt = performance.now();
      const reproduction = await this.measure(target, context, observers).catch(failedReproduction);
      const durationMs = Math.round(loadMs + performance.now() - startedAt);
      outcomes = [...outcomes, { target, reproduction, durationMs }];
    }
    return outcomes;
  }

  private async measure(
    target: ReproductionTarget,
    context: LensContext,
    observers: readonly Observer[],
  ): Promise<Reproduction> {
    const { finding } = target;
    if (finding.source === OBSERVERS) {
      if (!('occurrence' in target)) {
        throw new Error(`The observer finding ${finding.rule.id} has no occurrence to look for`);
      }
      return reproduceObservation(target, observers, context.screen);
    }
    const lens = this.options.lenses.find(({ name }) => name === finding.source);
    if (lens === undefined) {
      throw new Error(`No ${finding.source} lens is configured to reproduce ${finding.rule.id}`);
    }
    return lens.reproduce(target, context);
  }

  private record(outcomes: readonly Outcome[], index: number, url: string): Promise<Recorded[]> {
    return Promise.all(
      outcomes.map(async ({ target, reproduction, durationMs }) => {
        const key = targetKey(target);
        const ref = await this.options.ctx.evidence.putJson(`reproduction-${target.finding.id}`, {
          attempt: index,
          target: key,
          url,
          reproduction,
          environment: this.environment(viewportOf(target)),
        });
        const measurements: EvidenceItem = { kind: 'measurements', label: `reproduction ${index}`, ref };
        const attempt: Attempt = {
          index,
          occurrence: occurrenceOf(target),
          reproduced: reproduction.reproduced,
          observed: reproduction.observed,
          skipped: reproduction.skipped,
          durationMs,
          evidence: [measurements, ...reproduction.evidence],
        };
        return { key, attempt };
      }),
    );
  }
}

/**
 * `${finding.id}` for a step finding; `${finding.id}|${screenId}|${selector}|${viewport}` for an
 * occurrence, with its viewport's name and an empty selector when it has none.
 */
export function targetKey(target: ReproductionTarget): string {
  if (!('occurrence' in target)) return target.finding.id;
  const { screenId, selector, viewport } = target.occurrence;
  return `${target.finding.id}|${screenId}|${selector ?? ''}|${viewport.name}`;
}

/** Every one of `of` attempts was made, and every one reproduced. */
export function isReproduced(attempts: readonly Attempt[], of: number): boolean {
  return attempts.length === of && attempts.every((attempt) => attempt.reproduced);
}

/** Core's `navigate` with the crawl's timing; a navigation it reports as failed throws. */
async function navigateOrFail(page: Page, url: string): Promise<void> {
  const failure = await navigate(page, url, REPLAY_TIMING);
  if (failure !== null) throw new Error(failure);
}

/** A `LookoverError` is rethrown; any other error is the attempt's, as a reproduction that did not happen. */
function failedReproduction(error: unknown): Reproduction {
  if (error instanceof LookoverError) throw error;
  return {
    reproduced: false,
    observed: null,
    skipped: `${ERROR_SKIP_PREFIX}${describeError(error)}`,
    evidence: [],
  };
}

/** Each target once (the first of any repeat), so a key's attempts are one target's. */
function uniqueTargets(targets: readonly ReproductionTarget[]): ReproductionTarget[] {
  const keys = targets.map(targetKey);
  return targets.filter((target, index) => keys.indexOf(targetKey(target)) === index);
}

/**
 * The order the targets are measured in on an attempt's page: observer findings first, because the
 * observers hold what the navigation produced and a lens may reload the page; then each lens's targets
 * in the order of its rules, which is the order of its steps (the Tab walk leaves focus where it ended,
 * the sweep reloads), the lenses in the order given. A target no configured lens reports comes last.
 */
function inMeasuringOrder(
  targets: readonly ReproductionTarget[],
  lenses: readonly Lens[],
): ReproductionTarget[] {
  return targets.toSorted((a, b) => {
    const [rankA, rankB] = [rankOf(a, lenses), rankOf(b, lenses)];
    return rankA.lens - rankB.lens || rankA.rule - rankB.rule;
  });
}

function rankOf({ finding }: ReproductionTarget, lenses: readonly Lens[]): Rank {
  if (finding.source === OBSERVERS) return { lens: -1, rule: 0 };
  const lens = lenses.findIndex(({ name }) => name === finding.source);
  const rules = lenses[lens]?.rules ?? [];
  const rule = rules.indexOf(finding.rule.id);
  return { lens: lens === -1 ? lenses.length : lens, rule: rule === -1 ? rules.length : rule };
}

/**
 * The attempt's observers as `reproduceObservation` sees them: each one collects on its first `collect`
 * and hands that result to every later call, so every observer target of the attempt reads what the one
 * navigation produced (a second real `collect` would find the observer drained).
 */
function collectedOnce(observers: readonly Observer[]): Observer[] {
  return observers.map((observer) => {
    let collected: Promise<ObserverResult> | null = null;
    return {
      name: observer.name,
      attach: (ipage) => observer.attach(ipage),
      collect: (screen) => {
        collected ??= observer.collect(screen);
        return collected;
      },
    };
  });
}

function urlOf(target: ReproductionTarget): string {
  return 'occurrence' in target ? target.occurrence.url : target.finding.trace.url;
}

function viewportOf(target: ReproductionTarget): Viewport {
  return 'occurrence' in target ? target.occurrence.viewport : target.finding.trace.viewport;
}

function occurrenceOf(target: ReproductionTarget): Attempt['occurrence'] {
  if (!('occurrence' in target)) return null;
  const { screenId, selector, viewport } = target.occurrence;
  return { screenId, selector, viewport: viewport.name };
}
