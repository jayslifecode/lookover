import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppMap, Finding, FindingsFile } from '@jayslifecode/lookover-core';
import type { Severity } from '@jayslifecode/lookover-rules';
import { REPO_ROOT } from './bench-env.js';

/** The bench's seeded issues and controls; `bench/app/test/seeds.test.ts` checks its shape in full. */
export const SEEDS_FILE = join(REPO_ROOT, 'bench', 'seeds.json');

/**
 * The seeds that only show at one viewport, by id: `seeds.json` has no viewport field, so the viewport
 * an occurrence must have been seen at is kept here (and in `bench/README.md`).
 */
export const SEED_VIEWPORTS: Readonly<Record<string, string>> = { 'interaction-006': 'mobile' };

/** One entry of `bench/seeds.json`, as `bench/README.md` documents it. */
export interface Seed {
  readonly id: string;
  readonly lens: 'interaction' | 'consistency' | 'behaviour' | 'observers';
  /** A route pattern, as `app-map.json` writes it: `/organisations/[id]`. */
  readonly route: string;
  /** The affected element's selector as Lookover builds it, when the issue is on one element. */
  readonly selector?: string;
  /** The catalogue rule Lookover should report the issue under. */
  readonly rule: string;
  readonly expectedSeverity: Severity;
  /** A clean control: it looks like the issue, and Lookover must not report it. */
  readonly control?: boolean;
}

export interface Seeds {
  /** The seeded issues: each must be found (recall). */
  readonly issues: readonly Seed[];
  /** The controls: none may be flagged (precision). */
  readonly controls: readonly Seed[];
}

/** Reads `bench/seeds.json` and splits its entries into the seeded issues and the controls. */
export async function readSeeds(): Promise<Seeds> {
  const parsed: unknown = JSON.parse(await readFile(SEEDS_FILE, 'utf8'));
  if (!isSeedsFile(parsed)) {
    throw new Error(
      `${SEEDS_FILE} is not a version 1 seeds file whose entries name an id, a route and a rule; ` +
        'run the bench tests (pnpm --filter @jayslifecode/lookover-bench test) for the details',
    );
  }
  return {
    issues: parsed.issues.filter((seed) => seed.control !== true),
    controls: parsed.issues.filter((seed) => seed.control === true),
  };
}

/** Where a finding was seen: a route pattern, the element when there is one, and the viewport's name. */
export interface Place {
  readonly route: string;
  readonly selector: string | null;
  readonly viewport: string;
}

/** Hover feedback is only worth a look, so a seed of this rule is looked for in `worthALook` too. */
const WORTH_A_LOOK_RULE = 'interaction.hover-state-missing';

/**
 * A step finding is seen on its screen, whose route the App Map gives (`screenId`), on its target; an
 * occurrence finding wherever one of its occurrences was.
 */
export function placesOf(finding: Finding, map: AppMap): Place[] {
  if (finding.shape === 'occurrence') {
    return finding.occurrences.map(({ route, selector, viewport }) => ({
      route,
      selector,
      viewport: viewport.name,
    }));
  }
  const screen = map.screens.find((candidate) => candidate.id === finding.screenId);
  if (screen === undefined) return [];
  return [
    {
      route: screen.route,
      selector: finding.target?.selector ?? null,
      viewport: finding.trace.viewport.name,
    },
  ];
}

/**
 * Whether `finding` reports `seed`: the seed's rule, seen in one place that is on the seed's route, on
 * its element when the seed names one, and at its viewport when it only shows at one (`SEED_VIEWPORTS`).
 */
export function reportsSeed(finding: Finding, seed: Seed, map: AppMap): boolean {
  if (finding.rule.id !== seed.rule) return false;
  const viewport = SEED_VIEWPORTS[seed.id];
  return placesOf(finding, map).some(
    (place) =>
      place.route === seed.route &&
      (seed.selector === undefined || place.selector === seed.selector) &&
      (viewport === undefined || place.viewport === viewport),
  );
}

/** The findings a seeded issue may be found among: the candidates, and the worth-a-look list for hover. */
export function findingsFor(file: FindingsFile, seed: Seed): Finding[] {
  return seed.rule === WORTH_A_LOOK_RULE ? [...file.findings, ...file.worthALook] : file.findings;
}

/** The fields this suite reads; the bench's own test checks the rest of the shape. */
function isSeedsFile(value: unknown): value is { version: 1; issues: Seed[] } {
  if (typeof value !== 'object' || value === null) return false;
  const { version, issues } = value as { version?: unknown; issues?: unknown };
  return version === 1 && Array.isArray(issues) && issues.every(isSeed);
}

function isSeed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { id, route, rule, selector, control } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof route === 'string' &&
    typeof rule === 'string' &&
    (selector === undefined || typeof selector === 'string') &&
    (control === undefined || typeof control === 'boolean')
  );
}
