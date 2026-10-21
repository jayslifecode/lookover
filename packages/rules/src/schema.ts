import { z } from 'zod';

/** From most to least severe: the order a report lists findings in. */
export const SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const;

/** The catalogues a rule can come from; a rule id starts with its source and a dot. */
export const RULE_SOURCES = ['interaction', 'consistency', 'behaviour', 'observers'] as const;

export type Severity = (typeof SEVERITIES)[number];
export type RuleSource = (typeof RULE_SOURCES)[number];

const RULE_ID_PATTERN = /^[a-z]+\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const referenceSchema = z.strictObject({
  standard: z.string().min(1),
  criterion: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
});

export const ruleSchema = z
  .strictObject({
    id: z.string().regex(RULE_ID_PATTERN, 'A rule id is "<source>.<kebab-case-name>"'),
    source: z.enum(RULE_SOURCES),
    severity: z.enum(SEVERITIES),
    title: z
      .string()
      .min(1)
      .refine((title) => !title.endsWith('.'), 'A title does not end with a full stop'),
    expected: z.string().min(1),
    whyItMatters: z.string().min(1),
    fixHint: z.string().min(1),
    reference: referenceSchema.nullable(),
  })
  .refine((rule) => rule.id.startsWith(`${rule.source}.`), {
    message: 'A rule id starts with its source',
    path: ['source'],
  });

export type Rule = z.infer<typeof ruleSchema>;

/** A list of rules in which no id appears twice: one catalogue, or all of them together. */
export const rulesSchema = z.array(ruleSchema).superRefine((rules, context) => {
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (seen.has(rule.id)) {
      context.addIssue({ code: 'custom', message: `Duplicate rule id ${rule.id}`, path: [index, 'id'] });
    }
    seen.add(rule.id);
  }
});

/** One catalogue file: `catalogue/<source>.json`. */
export const catalogueSchema = z.strictObject({
  version: z.literal(1),
  rules: rulesSchema,
});

export type Catalogue = z.infer<typeof catalogueSchema>;
