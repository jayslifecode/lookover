import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { RULE_IDS, ruleById, SEVERITIES } from '@jayslifecode/lookover-rules';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

const APP_DIR = join(import.meta.dirname, '..', 'app');
const SEEDS_FILE = join(import.meta.dirname, '..', '..', 'seeds.json');
const PAGE_FILE = 'page.tsx';
const SEED_ID_PATTERN = /^[a-z]+-\d{3}$/;

/** The `seeds.json` shape documented in `bench/README.md`. */
const seedSchema = z.strictObject({
  id: z.string().regex(SEED_ID_PATTERN, 'An id is "<name>-<three digits>", e.g. interaction-001'),
  lens: z.enum(['interaction', 'consistency', 'behaviour', 'observers']),
  route: z.string().min(1),
  selector: z.string().min(1).optional(),
  rule: z.string().min(1),
  expectedSeverity: z.enum(SEVERITIES),
  control: z.boolean().optional(),
});

const seedsFileSchema = z.strictObject({
  version: z.literal(1),
  app: z.literal('bench/app'),
  issues: z.array(seedSchema),
});

type Seed = z.infer<typeof seedSchema>;

/** The route patterns of the app's pages, read from the `page.tsx` files under `app/`. */
function appRoutes(): ReadonlySet<string> {
  const pages = readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' }).filter(
    (path) => basename(path) === PAGE_FILE,
  );
  return new Set(
    pages.map((page) => {
      const directory = dirname(page);
      return directory === '.' ? '/' : `/${directory.split(sep).join('/')}`;
    }),
  );
}

function readSeeds(): Seed[] {
  const parsed = seedsFileSchema.safeParse(JSON.parse(readFileSync(SEEDS_FILE, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${SEEDS_FILE} does not match the seed shape\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.issues;
}

describe('bench/seeds.json', () => {
  test('every entry has the documented shape', () => {
    expect(() => readSeeds()).not.toThrow();
  });

  test('ids are unique', () => {
    const ids = readSeeds().map((seed) => seed.id);

    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  test('every route is one of the app pages', () => {
    const routes = appRoutes();

    const unknown = readSeeds().filter((seed) => !routes.has(seed.route));

    expect(unknown.map((seed) => `${seed.id}: ${seed.route}`)).toEqual([]);
  });

  test('every rule is in the rules catalogue', () => {
    const unknown = readSeeds().filter((seed) => !RULE_IDS.has(seed.rule));

    expect(unknown.map((seed) => `${seed.id}: ${seed.rule}`)).toEqual([]);
  });

  test("every expectedSeverity is the catalogue's severity for its rule", () => {
    const known = readSeeds().filter((seed) => RULE_IDS.has(seed.rule));

    const mismatched = known.filter((seed) => seed.expectedSeverity !== ruleById(seed.rule).severity);

    expect(
      mismatched.map(
        (seed) => `${seed.id}: ${seed.expectedSeverity}, ${seed.rule} is ${ruleById(seed.rule).severity}`,
      ),
    ).toEqual([]);
  });
});

describe('appRoutes', () => {
  test('lists the pages by route pattern, the dashboard as "/"', () => {
    expect(appRoutes()).toEqual(
      new Set([
        '/',
        '/login',
        '/organisations',
        '/organisations/[id]',
        '/organisations/new',
        '/reports',
        '/settings',
      ]),
    );
  });
});
