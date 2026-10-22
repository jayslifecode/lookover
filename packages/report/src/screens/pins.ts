import type { Finding, StepFinding } from '@jayslifecode/lookover-core';
import { compareText } from '@/data/reduce';
import { fixFirst, groups } from '@/data/selectors';

/*
 * Where the pins go on a screenshot (spec §11 "Pin → panel container transform", ported from the motion
 * study's `placePins`). A pin is a 24 px dot on the top-right corner of its finding's target, measured
 * inside the screenshot's border box, with its label (a tooltip: the finding's title) centred above it.
 * The label flips below the dot when, above, it would cover another dot (or leave the screenshot), and
 * slides sideways to stay inside the screenshot. Only a step finding with a target has a place; an
 * occurrence finding, or a step finding without a target, is listed beside the screenshot instead.
 *
 * Pure: the screenshot's sizes and the labels' widths come in, the placements go out.
 */

/** The dot's diameter: a 24 by 24 px target (WCAG 2.2, 2.5.8). */
export const DOT_SIZE = 24;
const HALF_DOT = DOT_SIZE / 2;
/** The label: 12 px text on a 16 px line, 5 px of padding above and below, and a 1 px border. */
export const LABEL_HEIGHT = 28;
/** Between the dot and its label. */
export const LABEL_GAP = 8;
/** How far inside the screenshot's left and right edges a label stays. */
export const LABEL_INSET = 8;
/** A label not measured yet: its title at about this many px a character (Manrope 600 at 12 px)… */
const ESTIMATED_CHAR_WIDTH = 7;
/** …plus 10 px of padding and a 1 px border on each side. */
const LABEL_FRAME_WIDTH = 22;

/** The screenshot as shown, inside its border, in CSS pixels. */
export interface ScreenshotBox {
  readonly width: number;
  readonly height: number;
}

export type LabelSide = 'above' | 'below';

/** A step finding with a target: one that has a place on the screenshot. */
export type PinnedFinding = StepFinding & { readonly target: NonNullable<StepFinding['target']> };

export interface PinPlacement {
  readonly finding: PinnedFinding;
  /** From 1, in fix-first order. */
  readonly number: number;
  /** The dot's top-left corner inside the screenshot's border box. */
  readonly left: number;
  readonly top: number;
  readonly label: LabelSide;
  /** How far the label moves right (negative: left) from centred on the dot, to stay inside. */
  readonly labelShift: number;
  /** The label's width, no wider than the screenshot less the insets. */
  readonly labelWidth: number;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Dot {
  readonly finding: PinnedFinding;
  readonly number: number;
  readonly rect: Rect;
}

const NOT_MEASURED: ReadonlyMap<string, number> = new Map();

export function isPinnable(finding: Finding): finding is PinnedFinding {
  return finding.shape === 'step' && finding.target !== null;
}

function compareByKey(a: Finding, b: Finding): number {
  return compareText(a.key, b.key) || compareText(a.id, b.id);
}

/** The pinnable findings in fix-first order: the groups by `fixFirst`, inside each by finding key. */
export function pinOrder(findings: readonly Finding[]): PinnedFinding[] {
  return fixFirst(groups(findings))
    .flatMap((group) => group.findings.toSorted(compareByKey))
    .filter(isPinnable);
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), Math.max(max, 0));
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

function dotOf(finding: PinnedFinding, number: number, scale: number, box: ScreenshotBox): Dot {
  const { x, y, width } = finding.target.box;
  const left = clamp((x + width) * scale - HALF_DOT, box.width - DOT_SIZE);
  const top = clamp(y * scale - HALF_DOT, box.height - DOT_SIZE);
  return { finding, number, rect: { left, top, right: left + DOT_SIZE, bottom: top + DOT_SIZE } };
}

function labelWidthOf(finding: Finding, measured: ReadonlyMap<string, number>, box: ScreenshotBox): number {
  const width = measured.get(finding.id) ?? finding.title.length * ESTIMATED_CHAR_WIDTH + LABEL_FRAME_WIDTH;
  return Math.max(Math.min(width, box.width - 2 * LABEL_INSET), 0);
}

/** The shift that keeps a label of `width`, centred on the dot, `LABEL_INSET` inside both edges. */
function shiftInside(dot: Rect, width: number, box: ScreenshotBox): number {
  const left = dot.left + HALF_DOT - width / 2;
  const right = left + width;
  if (right > box.width - LABEL_INSET) return box.width - LABEL_INSET - right;
  if (left < LABEL_INSET) return LABEL_INSET - left;
  return 0;
}

function labelRect(dot: Rect, width: number, shift: number, side: LabelSide): Rect {
  const left = dot.left + HALF_DOT - width / 2 + shift;
  const top = side === 'above' ? dot.top - LABEL_GAP - LABEL_HEIGHT : dot.bottom + LABEL_GAP;
  return { left, top, right: left + width, bottom: top + LABEL_HEIGHT };
}

function sideOf(dot: Dot, above: Rect, dots: readonly Dot[]): LabelSide {
  if (above.top < 0) return 'below';
  const coversAnother = dots.some((other) => other !== dot && overlaps(above, other.rect));
  return coversAnother ? 'below' : 'above';
}

/**
 * The pins of `findings` (the screen's confirmed findings) on a screenshot `naturalWidth` px wide as
 * captured and `displayedWidth` px wide as shown, inside `screenshotBox`. `labelWidths` holds the labels'
 * measured widths by finding id; a label not in it is given a width from its title. Nothing is placed
 * before the screenshot has a size.
 */
export function placePins(
  findings: readonly Finding[],
  naturalWidth: number,
  displayedWidth: number,
  screenshotBox: ScreenshotBox,
  labelWidths: ReadonlyMap<string, number> = NOT_MEASURED,
): PinPlacement[] {
  if (naturalWidth <= 0 || displayedWidth <= 0 || screenshotBox.width <= 0) return [];
  const scale = displayedWidth / naturalWidth;
  const dots = pinOrder(findings).map((finding, index) => dotOf(finding, index + 1, scale, screenshotBox));
  return dots.map((dot) => {
    const labelWidth = labelWidthOf(dot.finding, labelWidths, screenshotBox);
    // The shift is horizontal only, so it is the same above and below: the flip tests the shifted label.
    const labelShift = shiftInside(dot.rect, labelWidth, screenshotBox);
    const label = sideOf(dot, labelRect(dot.rect, labelWidth, labelShift, 'above'), dots);
    return {
      finding: dot.finding,
      number: dot.number,
      left: dot.rect.left,
      top: dot.rect.top,
      label,
      labelShift,
      labelWidth,
    };
  });
}
