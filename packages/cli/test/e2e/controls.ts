import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type LensSkip, RunLog, type Screen } from '@jayslifecode/lookover-core';
import type { GalleryState, StateGallery } from '@jayslifecode/lookover-lenses';
import type { Seed } from './seeds.js';

/** The lens's state gallery of a screen (`gallery-<screenId>-<hash>.json`); `null` when it wrote none. */
export async function readGallery(runDir: string, screenId: string): Promise<StateGallery | null> {
  const evidenceDir = join(runDir, 'evidence');
  const name = (await readdir(evidenceDir)).find((file) => file.startsWith(`gallery-${screenId}-`));
  if (name === undefined) return null;
  return JSON.parse(await readFile(join(evidenceDir, name), 'utf8')) as StateGallery;
}

/** What the lenses left out on each inspected screen, by screen id, from the run log. */
export async function inspectedSkips(runDir: string): Promise<ReadonlyMap<string, readonly LensSkip[]>> {
  const events = await RunLog.read(join(runDir, 'run.jsonl'));
  return new Map(
    events.flatMap((event) => (event.type === 'screen.inspected' ? [[event.screenId, event.skipped]] : [])),
  );
}

/** The state a control's rule is judged in, which its gallery entry must hold. */
const JUDGED_STATE: Readonly<Record<string, GalleryState>> = {
  'interaction.focus-visible-missing': 'focus',
  'interaction.hover-state-missing': 'hover',
};
const TARGET_SIZE_RULE = 'interaction.target-size';
/** The skips that would leave an element's target size unjudged: the whole static step, its rule, a node gone. */
const TARGET_SIZE_SKIPS: ReadonlySet<string> = new Set([
  'time-budget:static',
  'time-budget:target-size',
  'gone',
]);

/**
 * Whether the lens measured the control on `screen`, so that it not being flagged means it passed: a
 * forced-state control has a gallery entry that was not skipped and holds the state its rule needs; a
 * target-size control is one of the screen's elements, on a screen inspected without a skip that could
 * have left it out.
 */
export async function wasMeasured(
  control: Seed,
  screen: Screen,
  runDir: string,
  skips: ReadonlyMap<string, readonly LensSkip[]>,
): Promise<boolean> {
  const state = JUDGED_STATE[control.rule];
  if (state !== undefined) {
    const gallery = await readGallery(runDir, screen.id);
    const entry = gallery?.entries.find((candidate) => candidate.selector === control.selector);
    return entry !== undefined && entry.skipped === null && entry.states[state] !== undefined;
  }
  if (control.rule === TARGET_SIZE_RULE) {
    const skipped = skips.get(screen.id);
    const isListed = screen.elements.some((element) => element.selector === control.selector);
    return isListed && skipped !== undefined && !skipped.some(({ reason }) => TARGET_SIZE_SKIPS.has(reason));
  }
  throw new Error(`${control.id}: no way to tell whether a control of ${control.rule} was measured`);
}
