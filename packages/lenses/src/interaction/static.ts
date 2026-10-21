import {
  type Box,
  type ElementRef,
  type ElementTarget,
  type Finding,
  type LensContext,
  type LensSkip,
  type Occurrence,
  occurrenceFinding,
  type StepTrace,
  stableSelector,
  stepFinding,
} from '@jayslifecode/lookover-core';
import { type Rule, ruleById } from '@jayslifecode/lookover-rules';
import {
  blendOver,
  isLargeText,
  parseCssColor,
  RATIO_DECIMALS,
  requiredRatio,
  roundedContrastRatio,
} from './contrast.js';
import {
  COMPONENT_NAME_SOURCE,
  EFFECTIVE_BACKGROUND_SOURCE,
  type EffectiveBackground,
  IN_ACTIVEDESCENDANT_WIDGET_SOURCE,
  IS_INLINE_IN_TEXT_SOURCE,
  POSITIVE_TABINDEX_SOURCE,
  type PositiveTabindex,
  TEXT_SAMPLE_SOURCE,
  type TextSample,
} from './in-page.js';
import { evaluateSource, measureOn } from './measure.js';
import { tally } from './skips.js';
import { passesTargetSize } from './target-size.js';

/*
 * The four measures that need no forced state and no navigation: they read each element's text, box
 * and focusability as the page is now. `measureStatic` runs them all on one screen.
 */

/** Per screen, text contrast is judged for at most this many elements; the rest are counted in `skipped`. */
export const MAX_CONTRAST_ELEMENTS = 200;

/** The roles of a control a keyboard user has to be able to reach with the Tab key. */
export const MUST_BE_FOCUSABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'switch',
  'combobox',
  'slider',
  'spinbutton',
]);

const CONTRAST_FAIL_RULE = ruleById('interaction.text-contrast-fail');
const CONTRAST_LOW_RULE = ruleById('interaction.text-contrast-low');
const TARGET_SIZE_RULE = ruleById('interaction.target-size');
const KEYBOARD_RULE = ruleById('interaction.keyboard-unreachable');
const POSITIVE_TABINDEX_RULE = ruleById('interaction.positive-tabindex');

/** Under this ratio (WCAG 2.2 1.4.3, large text) text is unreadable, not merely under the minimum. */
const UNREADABLE_RATIO = 3;
/** The roles of `<input type="checkbox">` and `<input type="radio">`, which the browser draws itself. */
const NATIVE_TOGGLE_ROLES: ReadonlySet<string> = new Set(['checkbox', 'radio']);
/** The elements whose controls the browser draws itself. */
const NATIVE_CONTROL_TAGS: ReadonlySet<string> = new Set(['select', 'option']);
/** The element left the page between being extracted and being measured. */
const SKIP_GONE = 'gone';
const SKIP_CONTRAST_CAP = 'contrast-elements-cap';
/** WCAG 1.4.3 puts no contrast requirement on the text of an inactive user interface component. */
const SKIP_DISABLED = 'disabled';
/** A colour the page's canvas or `parseCssColor` cannot read. */
const SKIP_UNPARSEABLE = 'colour-unparseable';
const SIZE_DECIMALS = 1;

const CONTRAST_WHAT = 'text colour, background colour and contrast ratio';
const TARGET_SIZE_WHAT = 'size and the distance to the nearest other target';
const KEYBOARD_WHAT = 'whether the element can receive focus';

export interface StaticResult {
  findings: Finding[];
  skipped: LensSkip[];
}

interface FindingText {
  /** What the trace's last step measures; it also labels the measurements evidence. */
  what: string;
  observed: string;
  /** Stored as the finding's measurements, with the selector. */
  measured: Record<string, string | number | boolean>;
}

const NOTHING: StaticResult = { findings: [], skipped: [] };

/**
 * Applies the four static rules to a screen's elements: `interaction.text-contrast-fail` and
 * `-low`, `interaction.target-size`, `interaction.keyboard-unreachable` (each a step finding on the
 * element) and `interaction.positive-tabindex` (one occurrence finding for the screen). A measurement
 * that cannot be trusted is skipped with its reason rather than guessed at (see `judgeContrast`); the
 * exemptions are in `isExemptFromTargetSize`, `judgeTargetSize` and `judgeKeyboard`. Each per-element
 * rule stops at `context.deadline` and counts the elements it did not reach (`time-budget:<rule>`).
 */
export async function measureStatic(
  context: LensContext,
  elements: readonly ElementRef[],
): Promise<StaticResult> {
  const parts = [
    await measureContrast(context, elements),
    await measureTargetSize(context, elements),
    await measureKeyboard(context, elements),
    await measurePositiveTabindex(context),
  ];
  const all = parts.reduce(merge, NOTHING);
  return { findings: all.findings, skipped: tally(all.skipped) };
}

async function measureContrast(context: LensContext, elements: readonly ElementRef[]): Promise<StaticResult> {
  const judged = elements.slice(0, MAX_CONTRAST_ELEMENTS);
  const result = await judgeEach(context, 'text-contrast', judged, (element) =>
    judgeContrast(context, element),
  );
  const overCap = elements.length - judged.length;
  return overCap > 0 ? merge(result, skipped(SKIP_CONTRAST_CAP, overCap)) : result;
}

function measureTargetSize(context: LensContext, elements: readonly ElementRef[]): Promise<StaticResult> {
  const boxes = elements.map((element) => element.box);
  return judgeEach(context, 'target-size', elements, (element, index) =>
    judgeTargetSize(
      context,
      element,
      boxes.filter((_, at) => at !== index),
    ),
  );
}

function measureKeyboard(context: LensContext, elements: readonly ElementRef[]): Promise<StaticResult> {
  return judgeEach(context, 'keyboard-reachability', elements, (element) => judgeKeyboard(context, element));
}

/** `judge` for each element in order, until `context.deadline`; the elements not reached are counted. */
async function judgeEach(
  context: LensContext,
  rule: string,
  elements: readonly ElementRef[],
  judge: (element: ElementRef, index: number) => Promise<StaticResult>,
): Promise<StaticResult> {
  let result = NOTHING;
  for (const [index, element] of elements.entries()) {
    if (performance.now() >= context.deadline) {
      return merge(result, skipped(`time-budget:${rule}`, elements.length - index));
    }
    result = merge(result, await judge(element, index));
  }
  return result;
}

/**
 * Text contrast (WCAG 2.2 1.4.3) of an element that shows text: the text colour, blended over the
 * background when it has alpha, against the background behind it. The ratio is rounded once, and that
 * value is what is compared with 3 (`text-contrast-fail` under it) and with the minimum for the text's
 * size (`text-contrast-low` under that), printed and stored. An element without text has nothing to
 * judge, and a disabled one is skipped (`disabled`): WCAG exempts the text of an inactive component.
 * One whose text is painted by a descendant in other colours (`text-colour-uncertain:<why>`, see
 * `TEXT_SAMPLE_SOURCE`), whose background cannot be trusted (`background-uncertain:<why>`, see
 * `EFFECTIVE_BACKGROUND_SOURCE`) or whose text or background colour cannot be read
 * (`colour-unparseable`: the page's canvas rejects it, or `parseCssColor` cannot read what came back) is
 * skipped. Both colours come from the page already painted into sRGB, so the last is a guard rather
 * than a case.
 */
async function judgeContrast(context: LensContext, element: ElementRef): Promise<StaticResult> {
  if (element.disabled) return skipped(SKIP_DISABLED);
  const { cdp } = context.ipage;
  const sample = await measureOn<TextSample>(cdp, element, TEXT_SAMPLE_SOURCE);
  if (sample === null) return NOTHING;
  if (sample.uncertain !== null) return skipped(`text-colour-uncertain:${sample.uncertain}`);
  const background = await measureOn<EffectiveBackground>(cdp, element, EFFECTIVE_BACKGROUND_SOURCE);
  if (background === null) return skipped(SKIP_GONE);
  if (background.uncertain === SKIP_UNPARSEABLE) return skipped(SKIP_UNPARSEABLE);
  if (background.color === null) return skipped(`background-uncertain:${background.uncertain}`);
  const text = sample.color === null ? null : parseCssColor(sample.color);
  const behind = parseCssColor(background.color);
  if (sample.color === null || text === null || behind === null) return skipped(SKIP_UNPARSEABLE);
  const ratio = roundedContrastRatio(blendOver(text, behind), behind);
  const required = requiredRatio(isLargeText(sample.fontSize, sample.fontWeight));
  const rule = contrastRuleFor(ratio, required);
  if (rule === null) return NOTHING;
  return withFinding(
    await stepFindingFor(context, element, rule, {
      what: CONTRAST_WHAT,
      observed: `"${sample.text}" is ${sample.color} on ${background.color}, ${ratio.toFixed(RATIO_DECIMALS)}:1 (needs ${required}:1)`,
      measured: {
        colour: sample.color,
        background: background.color,
        ratio,
        required,
        fontSize: sample.fontSize,
        fontWeight: sample.fontWeight,
      },
    }),
  );
}

function contrastRuleFor(ratio: number, required: number): Rule | null {
  if (ratio < UNREADABLE_RATIO) return CONTRAST_FAIL_RULE;
  return ratio < required ? CONTRAST_LOW_RULE : null;
}

/** The controls the browser draws itself and the ones nobody can tap are not judged for their size. */
function isExemptFromTargetSize({ tag, role, disabled }: ElementRef): boolean {
  const isNativeToggle = tag === 'input' && NATIVE_TOGGLE_ROLES.has(role);
  return disabled || isNativeToggle || NATIVE_CONTROL_TAGS.has(tag);
}

/**
 * Target size (WCAG 2.2 2.5.8) of an element: see `passesTargetSize` for the 24 px minimum, the
 * spacing exception and which boxes count, with `others` the boxes of every other element on the
 * screen. Exempt are a native
 * checkbox, radio button, `<select>` and `<option>`, a disabled element, and a link or other inline
 * element in a line of text (`IS_INLINE_IN_TEXT_SOURCE`, asked only of an element that is too small).
 */
async function judgeTargetSize(
  context: LensContext,
  element: ElementRef,
  others: readonly Box[],
): Promise<StaticResult> {
  if (isExemptFromTargetSize(element)) return NOTHING;
  const size = passesTargetSize(element.box, others);
  if (size.ok) return NOTHING;
  const isInline = await measureOn<boolean>(context.ipage.cdp, element, IS_INLINE_IN_TEXT_SOURCE);
  if (isInline === null) return skipped(SKIP_GONE);
  if (isInline) return NOTHING;
  const { width, height } = element.box;
  return withFinding(
    await stepFindingFor(context, element, TARGET_SIZE_RULE, {
      what: TARGET_SIZE_WHAT,
      observed: `${forDisplay(width)}×${forDisplay(height)} px, nearest other target ${forDisplay(size.nearest)} px away`,
      measured: { width, height, nearest: size.nearest },
    }),
  );
}

/** A length as it is printed: to one decimal, without a trailing `.0`. */
function forDisplay(value: number): number {
  return Number(value.toFixed(SIZE_DECIMALS));
}

/**
 * Keyboard reachability (WCAG 2.2 2.1.1): a control of a role in `MUST_BE_FOCUSABLE_ROLES` that cannot
 * receive focus at all (no `tabindex`, not natively focusable). Not reported: a disabled one, and one
 * inside (not itself) an element with `aria-activedescendant`, which keeps focus and points at its
 * children.
 */
async function judgeKeyboard(context: LensContext, element: ElementRef): Promise<StaticResult> {
  const { focusable, disabled, role, tag } = element;
  if (focusable || disabled || !MUST_BE_FOCUSABLE_ROLES.has(role)) return NOTHING;
  const isManaged = await measureOn<boolean>(context.ipage.cdp, element, IN_ACTIVEDESCENDANT_WIDGET_SOURCE);
  if (isManaged === null) return skipped(SKIP_GONE);
  if (isManaged) return NOTHING;
  return withFinding(
    await stepFindingFor(context, element, KEYBOARD_RULE, {
      what: KEYBOARD_WHAT,
      observed: 'cannot receive keyboard focus',
      measured: { role, tag, focusable },
    }),
  );
}

/**
 * Positive tabindex (WCAG 2.2 2.4.3): every element of the page with a `tabindex` above 0, wherever it
 * is, as one occurrence finding for the screen (its key is the route) with one occurrence per element.
 */
async function measurePositiveTabindex(context: LensContext): Promise<StaticResult> {
  const found = await evaluateSource<PositiveTabindex[]>(context.ipage.page, POSITIVE_TABINDEX_SOURCE);
  if (found.length === 0) return NOTHING;
  const { id: screenId, route, url, viewport } = context.screen;
  const occurrences = found.map(
    ({ selector, tabindex }): Occurrence => ({
      screenId,
      route,
      url,
      viewport,
      selector: stableSelector(selector),
      measured: { tabindex },
    }),
  );
  const noun = occurrences.length === 1 ? 'element' : 'elements';
  return withFinding(
    occurrenceFinding({
      rule: POSITIVE_TABINDEX_RULE,
      key: route,
      occurrences,
      observed: `sets a tabindex above 0 on ${occurrences.length} ${noun}`,
      evidence: [],
    }),
  );
}

/**
 * A step finding for `rule` on the element, with the trace `navigate`, `set-viewport`, `measure` and
 * the measurements as its evidence.
 */
async function stepFindingFor(
  context: LensContext,
  element: ElementRef,
  rule: Rule,
  text: FindingText,
): Promise<Finding> {
  const { ctx, screen } = context;
  const ref = await ctx.evidence.putJson('measurements', { selector: element.selector, ...text.measured });
  return stepFinding({
    rule,
    screen,
    target: await targetOf(context, element),
    trace: traceOf(context, text.what),
    observed: text.observed,
    evidence: [{ kind: 'measurements', label: text.what, ref }],
  });
}

async function targetOf(context: LensContext, element: ElementRef): Promise<ElementTarget> {
  const { selector, role, name, box } = element;
  const componentName = await measureOn<string | null>(context.ipage.cdp, element, COMPONENT_NAME_SOURCE);
  return { selector, role, name, componentName: componentName ?? null, box };
}

function traceOf(context: LensContext, what: string): StepTrace {
  const { route, url, viewport } = context.screen;
  return {
    route,
    url,
    viewport,
    steps: [
      { kind: 'navigate', url },
      { kind: 'set-viewport', viewport },
      { kind: 'measure', what },
    ],
  };
}

function withFinding(finding: Finding): StaticResult {
  return { findings: [finding], skipped: [] };
}

function skipped(reason: string, count = 1): StaticResult {
  return { findings: [], skipped: [{ reason, count }] };
}

function merge(a: StaticResult, b: StaticResult): StaticResult {
  return { findings: [...a.findings, ...b.findings], skipped: [...a.skipped, ...b.skipped] };
}
