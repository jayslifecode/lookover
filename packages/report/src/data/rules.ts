import interaction from '@jayslifecode/lookover-rules/catalogue/interaction.json';
import observers from '@jayslifecode/lookover-rules/catalogue/observers.json';

/*
 * What the report shows of the rules catalogue: the standard each rule applies, as a link the reader can
 * follow. The rules package reads its catalogue files from disk, which a browser cannot, so the report
 * bundles the files themselves (the rules package validates them in its own tests). A link opens in a
 * new tab without a referrer; nothing is ever fetched from it.
 */

/** The published standard a rule applies (`reference` in the rules schema). */
export interface RuleReference {
  readonly standard: string;
  readonly criterion: string;
  readonly url: string;
}

interface CatalogueRule {
  readonly id: string;
  readonly reference: RuleReference | null;
}

const CATALOGUE_RULES: readonly CatalogueRule[] = [...interaction.rules, ...observers.rules];
const REFERENCES: ReadonlyMap<string, RuleReference> = new Map(
  CATALOGUE_RULES.flatMap((rule) => (rule.reference === null ? [] : [[rule.id, rule.reference] as const])),
);

/** The standard `ruleId` applies; `null` for a rule without one, or one the catalogue does not know. */
export function ruleReference(ruleId: string): RuleReference | null {
  return REFERENCES.get(ruleId) ?? null;
}
