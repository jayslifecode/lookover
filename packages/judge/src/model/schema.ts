import { z } from 'zod';

/** The longest `oracle` a verdict keeps; a longer one is cut (structured outputs reject `maxLength`). */
export const MAX_ORACLE_CHARS = 120;
/** The longest `note` a verdict keeps; a longer one is cut (structured outputs reject `maxLength`). */
export const MAX_NOTE_CHARS = 280;
const ELLIPSIS = '…';

/**
 * What the model answers for one finding. The limits are in the descriptions only: structured outputs
 * reject `minLength`, `maxLength` and the like, so `clampVerdict` enforces them. `timing` is never a model
 * attribution: the harness owns it.
 */
export const verdictSchema = z.object({
  verdict: z.enum(['confirm', 'reject']),
  attribution: z.enum(['product-defect', 'explorer-error', 'exemption']),
  oracle: z.string().describe('The standard or rule you applied, at most 120 characters'),
  note: z.string().describe('One or two plain sentences for a non-engineer, at most 280 characters'),
});

export type Verdict = z.infer<typeof verdictSchema>;

/** A verdict Lookover can use, or why the value is not one (naming fields, never quoting the value). */
export type VerdictReading = { ok: true; verdict: Verdict } | { ok: false; problem: string };

const REJECTION_ATTRIBUTIONS: ReadonlySet<Verdict['attribution']> = new Set(['explorer-error', 'exemption']);

/**
 * Reads `value` as a verdict: it must match the schema, a confirmation must be a product defect, and a
 * rejection must be an explorer error or an exemption with its reason in the note. The oracle and the
 * note come back trimmed and cut to their limits.
 */
export function readVerdict(value: unknown): VerdictReading {
  const parsed = verdictSchema.safeParse(value);
  if (!parsed.success) {
    // `String`, not `join` alone: a zod path may hold symbols, which `join` would throw on.
    const fields = parsed.error.issues.map(({ path }) =>
      path.length === 0 ? 'the verdict' : path.map(String).join('.'),
    );
    return { ok: false, problem: `invalid ${[...new Set(fields)].join(', ')}` };
  }
  const verdict = clampVerdict(parsed.data);
  const problem = pairingProblem(verdict);
  return problem === null ? { ok: true, verdict } : { ok: false, problem };
}

function pairingProblem({ verdict, attribution, note }: Verdict): string | null {
  if (verdict === 'confirm') {
    return attribution === 'product-defect' ? null : `a confirmation is a product defect, not ${attribution}`;
  }
  if (!REJECTION_ATTRIBUTIONS.has(attribution)) return 'a rejection is an explorer error or an exemption';
  return note === '' ? 'a rejection gives its reason in the note' : null;
}

/** `verdict` with its oracle and note trimmed and cut to `MAX_ORACLE_CHARS` and `MAX_NOTE_CHARS`. */
export function clampVerdict(verdict: Verdict): Verdict {
  return {
    ...verdict,
    oracle: clip(verdict.oracle, MAX_ORACLE_CHARS),
    note: clip(verdict.note, MAX_NOTE_CHARS),
  };
}

/** At most `max` characters (code points, so no emoji is split), ending in an ellipsis when cut. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= max) return trimmed;
  return `${characters
    .slice(0, max - ELLIPSIS.length)
    .join('')
    .trimEnd()}${ELLIPSIS}`;
}
