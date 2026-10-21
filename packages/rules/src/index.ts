import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { catalogueSchema, type Rule, type RuleSource, rulesSchema } from './schema.ts';

export type { Catalogue, Rule, RuleSource, Severity } from './schema.ts';
export { catalogueSchema, RULE_SOURCES, ruleSchema, SEVERITIES } from './schema.ts';

/** The catalogue files in `catalogue/`, one per source that has rules; a file is named for its source. */
const CATALOGUE_SOURCES = ['interaction', 'observers'] as const satisfies readonly RuleSource[];

function readJson(url: URL): unknown {
  const text = readFileSync(url, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${fileURLToPath(url)} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
}

function loadCatalogue(source: RuleSource): readonly Rule[] {
  // `catalogue/` sits next to both `src/` and `dist/`, so one relative URL works from either.
  const url = new URL(`../catalogue/${source}.json`, import.meta.url);
  const result = catalogueSchema.safeParse(readJson(url));
  if (!result.success) {
    throw new Error(`Invalid rules catalogue ${fileURLToPath(url)}\n${z.prettifyError(result.error)}`);
  }
  return result.data.rules;
}

function loadRules(): readonly Rule[] {
  const result = rulesSchema.safeParse(CATALOGUE_SOURCES.flatMap(loadCatalogue));
  if (!result.success) {
    throw new Error(`Invalid rules catalogues\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Every rule of every catalogue, validated when this module is first imported. */
export const RULES: readonly Rule[] = loadRules();

export const RULE_IDS: ReadonlySet<string> = new Set(RULES.map((rule) => rule.id));

const RULES_BY_ID: ReadonlyMap<string, Rule> = new Map(RULES.map((rule) => [rule.id, rule]));

/** Throws a plain `Error`: asking for a rule that does not exist is a bug in the caller. */
export function ruleById(id: string): Rule {
  const rule = RULES_BY_ID.get(id);
  if (rule === undefined) throw new Error(`Unknown rule ${id}`);
  return rule;
}
