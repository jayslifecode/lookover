import type { Finding, Severity, StepFinding } from '@jayslifecode/lookover-core';
import { compareText } from '@/data/reduce';
import { fixFirst, groups, SEVERITY_ORDER } from '@/data/selectors';

/*
 * Where the pins go on a screenshot (spec §11 "Pin → panel container transform", ported from the motion
 * study's `placePins`). A pin is a 24 px dot on the top-right corner of its finding's target, measured
 * inside the screenshot's border box, with its label (a tooltip) centred above it. The label flips below
 * the dot when, above, it would cover another dot (or leave the screenshot), and slides sideways to stay
 * inside the screenshot. Only a step finding with a target has a place; an occurrence finding, or a step
 * finding without a target, is listed beside the screenshot instead.
 *
 * Dots closer than `PIN_CLUSTER_PX` at the displayed scale are drawn as one cluster pin: walking the dots
 * in fix-first order, each joins the first cluster whose anchor (its first dot) is that near, else starts
 * one. A cluster sits on its anchor's dot, takes its members' highest severity, shows their count, and
 * its tooltip lists the first titles; its members keep their own numbers.
 *
 * Pure: the screenshot's sizes and the labels' widths come in, the placements go out.
 */

/** The dot's diameter: a 24 by 24 px target (WCAG 2.2, 2.5.8). */
export const DOT_SIZE = 24;
const HALF_DOT = DOT_SIZE / 2;
/** Dots whose centres are closer than this, in displayed px, are drawn as one cluster pin. */
export const PIN_CLUSTER_PX = 24;
/** A cluster's tooltip lists this many titles, then how many more. */
export const CLUSTER_TITLES_SHOWN = 3;
/** One line of a label: 12 px text on a 16 px line… */
const LABEL_LINE_HEIGHT = 16;
/** …in 5 px of padding above and below and a 1 px border. */
const LABEL_FRAME_HEIGHT = 12;
/** A one-line label's height. */
export const LABEL_HEIGHT = LABEL_LINE_HEIGHT + LABEL_FRAME_HEIGHT;
/** Between the dot and its label. */
export const LABEL_GAP = 8;
/** How far inside the screenshot's left and right edges a label stays. */
export const LABEL_INSET = 8;
/** A label not measured yet: its longest line at about this many px a character (Manrope 600 at 12 px)… */
const ESTIMATED_CHAR_WIDTH = 7;
/** …plus 10 px of padding and a 1 px border on each side. */
const LABEL_FRAME_WIDTH = 22;
/** Between a cluster's dot and its popover, and how far inside the screenshot the popover stays. */
export const POPOVER_GAP = 8;
export const POPOVER_INSET = 8;
const POPOVER_MAX_WIDTH = 320;
/** One option of the popover (a 32 px row), and the popover's 4 px padding and 1 px border. */
const POPOVER_OPTION_HEIGHT = 32;
const POPOVER_FRAME_HEIGHT = 10;

/** The screenshot as shown, inside its border, in CSS pixels. */
export interface ScreenshotBox {
  readonly width: number;
  readonly height: number;
}

export type LabelSide = 'above' | 'below';

/** A step finding with a target: one that has a place on the screenshot. */
export type PinnedFinding = StepFinding & { readonly target: NonNullable<StepFinding['target']> };

/** A pinned finding and its number, from 1 in fix-first order across the screen. */
export interface NumberedFinding {
  readonly finding: PinnedFinding;
  readonly number: number;
}

export interface PinPlacement {
  /** The pin's finding; a cluster's first. */
  readonly finding: PinnedFinding;
  readonly number: number;
  /** Every finding drawn at this dot, fix-first: one for a pin, more for a cluster. */
  readonly members: readonly NumberedFinding[];
  /** The most severe of the members. */
  readonly severity: Severity;
  /** The dot's top-left corner inside the screenshot's border box. */
  readonly left: number;
  readonly top: number;
  readonly label: LabelSide;
  /** How far the label moves right (negative: left) from centred on the dot, to stay inside. */
  readonly labelShift: number;
  /** The label's width, no wider than the screenshot less the insets. */
  readonly labelWidth: number;
  /** The tooltip's lines: the title, or a cluster's first titles and how many more. */
  readonly labelLines: readonly string[];
}

/** Where a cluster's popover goes: below the dot (`edge` is its top), or above it (`edge` is its bottom). */
export interface PopoverPlacement {
  readonly side: LabelSide;
  readonly edge: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Dot extends NumberedFinding {
  readonly rect: Rect;
}

interface Cluster {
  readonly anchor: Dot;
  readonly members: readonly Dot[];
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

/** The accessible name: `<n>. <title>`, or `<count> findings near <first title>` for a cluster. */
export function pinName(placement: PinPlacement): string {
  const count = placement.members.length;
  if (count === 1) return `${placement.number}. ${placement.finding.title}`;
  return `${count} findings near ${placement.finding.title}`;
}

/** What the dot shows: the pin's number, or the cluster's count. */
export function pinFace(placement: PinPlacement): string {
  const count = placement.members.length;
  return String(count === 1 ? placement.number : count);
}

function labelLinesOf(members: readonly NumberedFinding[]): string[] {
  const titles = members.slice(0, CLUSTER_TITLES_SHOWN).map(({ finding }) => finding.title);
  const more = members.length - CLUSTER_TITLES_SHOWN;
  return more > 0 ? [...titles, `… and ${more} more`] : titles;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(max, min));
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

function dotOf(finding: PinnedFinding, number: number, scale: number, box: ScreenshotBox): Dot {
  const { x, y, width } = finding.target.box;
  const left = clamp((x + width) * scale - HALF_DOT, 0, box.width - DOT_SIZE);
  const top = clamp(y * scale - HALF_DOT, 0, box.height - DOT_SIZE);
  return { finding, number, rect: { left, top, right: left + DOT_SIZE, bottom: top + DOT_SIZE } };
}

function distance(a: Rect, b: Rect): number {
  return Math.hypot(a.left - b.left, a.top - b.top);
}

/** Greedy, in the dots' order: each joins the first cluster whose anchor is nearer than PIN_CLUSTER_PX. */
function clustered(dots: readonly Dot[]): Cluster[] {
  return dots.reduce<Cluster[]>((clusters, dot) => {
    const near = clusters.findIndex(({ anchor }) => distance(anchor.rect, dot.rect) < PIN_CLUSTER_PX);
    if (near === -1) return clusters.concat({ anchor: dot, members: [dot] });
    return clusters.map((cluster, index) =>
      index === near ? { ...cluster, members: [...cluster.members, dot] } : cluster,
    );
  }, []);
}

function mostSevere(members: readonly NumberedFinding[], fallback: Severity): Severity {
  const ranks = members.map(({ finding }) => SEVERITY_ORDER.indexOf(finding.severity));
  return SEVERITY_ORDER[Math.min(...ranks)] ?? fallback;
}

function labelWidthOf(
  id: string,
  lines: readonly string[],
  measured: ReadonlyMap<string, number>,
  box: ScreenshotBox,
): number {
  const longest = Math.max(...lines.map((line) => line.length));
  const width = measured.get(id) ?? longest * ESTIMATED_CHAR_WIDTH + LABEL_FRAME_WIDTH;
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

/** The label above the dot, where it would be drawn. */
function labelAbove(dot: Rect, width: number, height: number, shift: number): Rect {
  const left = dot.left + HALF_DOT - width / 2 + shift;
  const bottom = dot.top - LABEL_GAP;
  return { left, top: bottom - height, right: left + width, bottom };
}

function placeCluster(
  cluster: Cluster,
  clusters: readonly Cluster[],
  labelWidths: ReadonlyMap<string, number>,
  box: ScreenshotBox,
): PinPlacement {
  const { anchor, members } = cluster;
  const labelLines = labelLinesOf(members);
  const labelWidth = labelWidthOf(anchor.finding.id, labelLines, labelWidths, box);
  // The shift is horizontal only, so it is the same above and below: the flip tests the shifted label.
  const labelShift = shiftInside(anchor.rect, labelWidth, box);
  const height = labelLines.length * LABEL_LINE_HEIGHT + LABEL_FRAME_HEIGHT;
  const above = labelAbove(anchor.rect, labelWidth, height, labelShift);
  const coversAnother = clusters.some((other) => other !== cluster && overlaps(above, other.anchor.rect));
  return {
    finding: anchor.finding,
    number: anchor.number,
    members: members.map(({ finding, number }) => ({ finding, number })),
    severity: mostSevere(members, anchor.finding.severity),
    left: anchor.rect.left,
    top: anchor.rect.top,
    label: above.top < 0 || coversAnother ? 'below' : 'above',
    labelShift,
    labelWidth,
    labelLines,
  };
}

/**
 * The pins of `findings` (the screen's confirmed findings) on a screenshot `naturalWidth` px wide as
 * captured and `displayedWidth` px wide as shown, inside `screenshotBox`, clustered. `labelWidths` holds
 * the labels' measured widths by the pin's first finding id; a label not in it is given a width from its
 * longest line. Nothing is placed before the screenshot has a size.
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
  const clusters = clustered(dots);
  return clusters.map((cluster) => placeCluster(cluster, clusters, labelWidths, screenshotBox));
}

/**
 * Where a cluster's popover of `optionCount` findings goes: centred under the dot and kept inside the
 * screenshot; above the dot when it does not fit below and there is more room above. Its height is capped
 * at the room it has (it scrolls past that).
 */
export function popoverBox(
  pin: Pick<PinPlacement, 'left' | 'top'>,
  optionCount: number,
  box: ScreenshotBox,
): PopoverPlacement {
  const width = Math.max(Math.min(POPOVER_MAX_WIDTH, box.width - 2 * POPOVER_INSET), 0);
  const left = clamp(pin.left + HALF_DOT - width / 2, POPOVER_INSET, box.width - POPOVER_INSET - width);
  const height = optionCount * POPOVER_OPTION_HEIGHT + POPOVER_FRAME_HEIGHT;
  const roomBelow = box.height - POPOVER_INSET - (pin.top + DOT_SIZE + POPOVER_GAP);
  const roomAbove = pin.top - POPOVER_GAP - POPOVER_INSET;
  if (height <= roomBelow || roomBelow >= roomAbove) {
    const edge = pin.top + DOT_SIZE + POPOVER_GAP;
    return { side: 'below', edge, left, width, maxHeight: Math.max(roomBelow, 0) };
  }
  const edge = box.height - pin.top + POPOVER_GAP;
  return { side: 'above', edge, left, width, maxHeight: Math.max(roomAbove, 0) };
}
