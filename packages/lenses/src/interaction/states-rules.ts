import {
  type ElementTarget,
  type EvidenceItem,
  type Finding,
  type ForcedState,
  type LensContext,
  type LensSkip,
  type StepTrace,
  stepFinding,
} from '@jayslifecode/lookover-core';
import { type Rule, ruleById } from '@jayslifecode/lookover-rules';
import { blendOver, contrastRatio, parseCssColor } from './contrast.js';
import {
  EFFECTIVE_BACKGROUND_SOURCE,
  type EffectiveBackground,
  STATE_STYLE_PROPERTIES,
  type StyleSnapshot,
  type StyleValues,
} from './in-page.js';
import { measureOn } from './measure.js';
import type { ForcibleElement, GalleryEntry, GalleryState } from './states.js';

/*
 * The three rules `captureStates` applies to a control once its states are captured, and the two
 * comparisons they rest on.
 */

const FOCUS_VISIBLE_RULE = ruleById('interaction.focus-visible-missing');
const INDICATOR_CONTRAST_RULE = ruleById('interaction.focus-indicator-contrast');
const HOVER_RULE = ruleById('interaction.hover-state-missing');

/** WCAG 2.2 1.4.11 (non-text contrast): a focus indicator needs 3:1 against the colour next to it. */
const MIN_INDICATOR_RATIO = 3;
const RATIO_DECIMALS = 2;
/** The roles a pointer user clicks, and so expects hover feedback from. */
const HOVER_ROLES: ReadonlySet<string> = new Set(['button', 'link']);
const SNAPSHOT_PARTS = ['self', 'before', 'after'] as const;
const OUTLINE_PROPERTIES = ['outline-style', 'outline-width', 'outline-color'] as const;
/**
 * One computed `box-shadow` layer: Chromium writes its colour first, then 2 to 4 lengths in px
 * (x, y, blur, spread), then `inset` for an inner shadow.
 */
const SHADOW_LAYER = /^([a-z-]+\([^()]*\)|[a-z-]+)((?:\s+-?[\d.]+px){2,4})(\s+inset)?$/;
/** A comma between layers; the commas inside a colour function are followed by its `)` first. */
const LAYER_SEPARATOR = /,(?![^(]*\))/;

const STATE_LABELS: Readonly<Record<GalleryState, string>> = {
  rest: 'at rest',
  hover: 'hovered',
  focus: 'focused',
  active: 'pressed',
};
const FOCUS_STYLES = 'computed styles of the control and its ::before/::after, before and after focus';
const HOVER_STYLES = 'computed styles of the control and its ::before/::after, before and after hover';
const INDICATOR_COLOURS = 'the focus indicator colour and the background colour behind the control';

/** `EFFECTIVE_BACKGROUND_SOURCE` for the element's parent: what an outline or ring outside the box sits on. */
const PARENT_BACKGROUND_SOURCE = `function () { return (${EFFECTIVE_BACKGROUND_SOURCE}).call(this.parentElement ?? this); }`;

export interface Judged {
  findings: Finding[];
  worthALook: Finding[];
  skipped: LensSkip[];
}

interface Subject {
  context: LensContext;
  element: ForcibleElement;
  entry: GalleryEntry;
  target: ElementTarget;
}

const NOTHING: Judged = { findings: [], worthALook: [], skipped: [] };

/** Whether any tracked property differs between the two snapshots, on the element, `::before` or `::after`. */
export function stateDiffers(rest: StyleSnapshot, forced: StyleSnapshot): boolean {
  return SNAPSHOT_PARTS.some((part) =>
    STATE_STYLE_PROPERTIES.some((name) => rest[part][name] !== forced[part][name]),
  );
}

/**
 * The colour of the mark focus adds around the element, to judge its contrast by: the `outline-color`
 * when focus gives the element a visible outline (not `none`, wider than 0, not fully transparent) that
 * differs from its rest outline; else the colour of the outermost `box-shadow` layer focus adds that
 * can be seen (not transparent, not `inset`, reaching past the box), so the white offset of a ring
 * and the empty layers Tailwind writes are passed over; else `null`: the mark is a fill or text change,
 * an inner ring or something on `::before`/`::after`, and its contrast is not checked.
 */
export function focusIndicatorColor(rest: StyleSnapshot, focus: StyleSnapshot): string | null {
  return outlineIndicator(rest.self, focus.self) ?? shadowIndicator(rest.self, focus.self);
}

/**
 * Applies the rules to a control whose states were all captured: `focus-visible-missing` and
 * `focus-indicator-contrast` for a focusable control (into `findings`), `hover-state-missing` for a
 * button or a link (into `worthALook`). An indicator whose background cannot be trusted is skipped.
 */
export async function judgeStates(
  context: LensContext,
  element: ForcibleElement,
  entry: GalleryEntry,
): Promise<Judged> {
  const { rest, hover, focus } = entry.states;
  if (entry.skipped !== null || rest === undefined || hover === undefined || focus === undefined) {
    return NOTHING;
  }
  const target = { ...pickTarget(element), componentName: entry.componentName };
  const subject: Subject = { context, element, entry, target };
  const focusJudged = element.focusable ? await judgeFocus(subject, rest, focus) : NOTHING;
  const isHoverMissing = HOVER_ROLES.has(element.role) && !stateDiffers(rest, hover);
  return { ...focusJudged, worthALook: isHoverMissing ? [await hoverMissing(subject)] : [] };
}

async function judgeFocus(subject: Subject, rest: StyleSnapshot, focus: StyleSnapshot): Promise<Judged> {
  if (!stateDiffers(rest, focus)) {
    const finding = await stateFinding(subject, FOCUS_VISIBLE_RULE, 'focus', {
      what: FOCUS_STYLES,
      observed: 'shows no change when it receives keyboard focus',
    });
    return { ...NOTHING, findings: [finding] };
  }
  const indicator = focusIndicatorColor(rest, focus);
  return indicator === null ? NOTHING : judgeIndicator(subject, indicator);
}

async function judgeIndicator(subject: Subject, indicator: string): Promise<Judged> {
  const { cdp } = subject.context.ipage;
  const background = await measureOn<EffectiveBackground>(cdp, subject.element, PARENT_BACKGROUND_SOURCE);
  if (background === null) return NOTHING;
  if (background.color === null) {
    return {
      ...NOTHING,
      skipped: [{ reason: `focus-indicator-background:${background.uncertain}`, count: 1 }],
    };
  }
  const mark = parseCssColor(indicator);
  const behind = parseCssColor(background.color);
  if (mark === null || behind === null) {
    return { ...NOTHING, skipped: [{ reason: 'focus-indicator-colour-unreadable', count: 1 }] };
  }
  const ratio = contrastRatio(blendOver(mark, behind), behind);
  if (ratio >= MIN_INDICATOR_RATIO) return NOTHING;
  const finding = await stateFinding(subject, INDICATOR_CONTRAST_RULE, 'focus', {
    what: INDICATOR_COLOURS,
    observed: `has a focus outline ${indicator} with ${ratio.toFixed(RATIO_DECIMALS)}:1 contrast against ${background.color}`,
    measured: { indicator, background: background.color },
  });
  return { ...NOTHING, findings: [finding] };
}

function hoverMissing(subject: Subject): Promise<Finding> {
  return stateFinding(subject, HOVER_RULE, 'hover', {
    what: HOVER_STYLES,
    observed: 'shows no change when the pointer is over it',
  });
}

interface FindingText {
  /** What the trace's last step measures. */
  what: string;
  observed: string;
  /** Stored with the style snapshots. */
  measured?: Record<string, string>;
}

/**
 * A step finding for `rule` on the control, reproduced by forcing `state`, with the rest and `state`
 * crops (when the control was cropped) and the two style snapshots as evidence.
 */
async function stateFinding(
  subject: Subject,
  rule: Rule,
  state: ForcedState,
  text: FindingText,
): Promise<Finding> {
  const { context, target } = subject;
  return stepFinding({
    rule,
    screen: context.screen,
    target,
    trace: traceOf(context, target.selector, state, text.what),
    observed: text.observed,
    evidence: await evidenceOf(subject, state, text.measured ?? {}),
  });
}

function traceOf(context: LensContext, selector: string, state: ForcedState, what: string): StepTrace {
  const { route, url, viewport } = context.screen;
  return {
    route,
    url,
    viewport,
    steps: [
      { kind: 'navigate', url },
      { kind: 'set-viewport', viewport },
      { kind: 'force-state', selector, state },
      { kind: 'measure', what },
    ],
  };
}

async function evidenceOf(
  { context, entry }: Subject,
  state: ForcedState,
  measured: Record<string, string>,
): Promise<EvidenceItem[]> {
  const crops = (['rest', state] as const).flatMap((shown): EvidenceItem[] => {
    const ref = entry.crops[shown];
    return ref === undefined ? [] : [{ kind: 'crop', label: STATE_LABELS[shown], ref }];
  });
  const styles = await context.ctx.evidence.putJson('styles', {
    selector: entry.selector,
    rest: entry.states.rest,
    [state]: entry.states[state],
    ...measured,
  });
  const label = `computed styles ${STATE_LABELS.rest} and ${STATE_LABELS[state]}`;
  return [...crops, { kind: 'styles', label, ref: styles }];
}

function pickTarget({ selector, role, name, box }: ForcibleElement): Omit<ElementTarget, 'componentName'> {
  return { selector, role, name, box };
}

function outlineIndicator(rest: StyleValues, focus: StyleValues): string | null {
  const isChanged = OUTLINE_PROPERTIES.some((name) => rest[name] !== focus[name]);
  return isChanged && isVisibleOutline(focus) ? focus['outline-color'] : null;
}

function isVisibleOutline(values: StyleValues): boolean {
  return (
    values['outline-style'] !== 'none' &&
    Number.parseFloat(values['outline-width']) > 0 &&
    !isTransparent(values['outline-color'])
  );
}

interface ShadowLayer {
  color: string;
  /** How far past the box the layer reaches: blur, spread and the larger offset. */
  reach: number;
  isInset: boolean;
}

function shadowIndicator(rest: StyleValues, focus: StyleValues): string | null {
  const atRest = new Set(shadowLayers(rest['box-shadow']));
  const added = shadowLayers(focus['box-shadow'])
    .filter((layer) => !atRest.has(layer))
    .map(parseShadowLayer)
    .filter(
      (layer): layer is ShadowLayer =>
        layer !== null && !layer.isInset && layer.reach > 0 && !isTransparent(layer.color),
    );
  const outermost = added.reduce<ShadowLayer | null>(
    (widest, layer) => (widest === null || layer.reach > widest.reach ? layer : widest),
    null,
  );
  return outermost?.color ?? null;
}

function shadowLayers(value: string): string[] {
  return value === 'none' ? [] : value.split(LAYER_SEPARATOR).map((layer) => layer.trim());
}

function parseShadowLayer(text: string): ShadowLayer | null {
  const match = SHADOW_LAYER.exec(text);
  if (match === null) return null;
  const [, color = '', lengths = '', inset] = match;
  const [x = 0, y = 0, blur = 0, spread = 0] = lengths.trim().split(/\s+/).map(Number.parseFloat);
  return { color, reach: blur + spread + Math.max(Math.abs(x), Math.abs(y)), isInset: inset !== undefined };
}

/** A colour that cannot be read is not known to be transparent; the contrast check then skips it. */
function isTransparent(color: string): boolean {
  return parseCssColor(color)?.a === 0;
}
