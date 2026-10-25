import type { Page } from 'playwright';

/*
 * The report's frame budget (spec §11 "Smoothness rules", rule 6), measured as the motion study measured
 * its baseline: the time between consecutive `requestAnimationFrame` callbacks while an interaction runs.
 * The sampler is injected into the page with `page.evaluate`. It can also record, at every frame, one
 * element's text and how many animations are running, so a test can say what was on screen on each
 * frame and whether anything moved.
 */

/** Two frames at 60 Hz: one frame over this is a dropped frame the reader can see. */
export const FRAME_BUDGET_MS = 34;
/** A frame this long is a stall, never allowed. */
export const FRAME_HARD_LIMIT_MS = 60;
/** How many frames over the budget one interaction may have. */
export const FRAMES_OVER_BUDGET_ALLOWED = 1;
/** Ten seconds at 60 Hz: more than any one interaction is sampled for. */
const MAX_SAMPLED_FRAMES = 600;
const SAMPLER_KEY = '__lookoverFrameSampler';

/** What to record at each frame besides its time. */
export interface FrameProbes {
  /** The text of the first element this selector matches. */
  readonly textOf?: string;
  /** How many animations `document.getAnimations()` returns (CSS transitions included). */
  readonly countAnimations?: boolean;
}

/** What the sampler recorded, one entry per frame. */
export interface FrameSample {
  readonly deltasMs: readonly number[];
  /** The probed element's text (`null`: nothing matched); empty without `textOf`. */
  readonly texts: readonly (string | null)[];
  /** The running animations; empty without `countAnimations`. */
  readonly animations: readonly number[];
}

export interface FrameStats {
  readonly frames: number;
  readonly averageMs: number;
  readonly maxMs: number;
  readonly overBudget: number;
  readonly overHardLimit: number;
}

/** The sampler as it lives in the page: fixed-size buffers, so sampling allocates nothing per frame. */
interface PageSampler {
  readonly deltas: Float64Array;
  readonly animations: Uint16Array;
  readonly texts: (string | null)[];
  count: number;
  last: number | null;
  isRunning: boolean;
}

/** Starts recording frames in `page`, with `probes`; a sampler already running there is replaced. */
export async function startSampling(page: Page, probes: FrameProbes = {}): Promise<void> {
  await page.evaluate(
    ({ key, selector, isCounting, max }) => {
      const host = window as unknown as Record<string, PageSampler | undefined>;
      const previous = host[key];
      if (previous !== undefined) previous.isRunning = false;
      // Page-side buffers written in place: allocating per frame would itself cost frames.
      const sampler: PageSampler = {
        deltas: new Float64Array(max),
        animations: new Uint16Array(max),
        texts: [],
        count: 0,
        last: null,
        isRunning: true,
      };
      host[key] = sampler;
      const tick = (now: number) => {
        if (!sampler.isRunning || sampler.count >= max) return;
        if (sampler.last !== null) {
          sampler.deltas[sampler.count] = now - sampler.last;
          if (selector !== null) {
            sampler.texts[sampler.count] = document.querySelector(selector)?.textContent ?? null;
          }
          if (isCounting) sampler.animations[sampler.count] = document.getAnimations().length;
          sampler.count += 1;
        }
        sampler.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    {
      key: SAMPLER_KEY,
      selector: probes.textOf ?? null,
      isCounting: probes.countAnimations === true,
      max: MAX_SAMPLED_FRAMES,
    },
  );
}

/** Stops the sampler `startSampling` started in `page` and returns what it recorded. */
export async function stopSampling(page: Page, probes: FrameProbes = {}): Promise<FrameSample> {
  const sample = await page.evaluate((key) => {
    const sampler = (window as unknown as Record<string, PageSampler | undefined>)[key];
    if (sampler === undefined) throw new Error('No frame sampler is running in the page');
    sampler.isRunning = false;
    return {
      deltasMs: Array.from(sampler.deltas.subarray(0, sampler.count)),
      texts: sampler.texts.slice(0, sampler.count),
      animations: Array.from(sampler.animations.subarray(0, sampler.count)),
    };
  }, SAMPLER_KEY);
  return probes.countAnimations === true ? sample : { ...sample, animations: [] };
}

/** Records the frames while `interaction` runs, with `probes`. */
export async function sampleFrames(
  page: Page,
  interaction: () => Promise<void>,
  probes: FrameProbes = {},
): Promise<FrameSample> {
  await startSampling(page, probes);
  await interaction();
  return stopSampling(page, probes);
}

const HUNDREDTHS = 100;

export function roundedMs(ms: number): number {
  return Math.round(ms * HUNDREDTHS) / HUNDREDTHS;
}

export function frameStats(deltasMs: readonly number[]): FrameStats {
  const total = deltasMs.reduce((sum, delta) => sum + delta, 0);
  return {
    frames: deltasMs.length,
    averageMs: deltasMs.length === 0 ? 0 : roundedMs(total / deltasMs.length),
    maxMs: roundedMs(Math.max(0, ...deltasMs)),
    overBudget: deltasMs.filter((delta) => delta > FRAME_BUDGET_MS).length,
    overHardLimit: deltasMs.filter((delta) => delta > FRAME_HARD_LIMIT_MS).length,
  };
}

/** One line for the test's output: `<name>: <frames> frames, average <a> ms, worst <m> ms, …`. */
export function describeStats(name: string, stats: FrameStats): string {
  return (
    `${name}: ${stats.frames} frames, average ${stats.averageMs} ms, worst ${stats.maxMs} ms, ` +
    `${stats.overBudget} over ${FRAME_BUDGET_MS} ms, ${stats.overHardLimit} over ${FRAME_HARD_LIMIT_MS} ms`
  );
}
