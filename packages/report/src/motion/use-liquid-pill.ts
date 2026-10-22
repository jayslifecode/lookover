import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from './reduced';
import { createLoop, createSpring, retune, type Spring, type SpringConfig } from './spring';

/*
 * The liquid pill of spec §11, ported from the motion study's `liquidPill` (v10): a full-width layer
 * clipped to its two edges (`clip-path: inset(0 R 0 L round 999px)`, round caps at any width) over a fill
 * inset 1 px. Each edge is a spring and the one facing the destination leads, so the pill stretches on
 * the way; it lifts 4 % with a shadow while it travels, its highlight trails by up to 10 px, and at rest it
 * leans up to 6 px toward the pointer. A drag starts after 5 px and its release snaps to the nearest tab,
 * projected 80 ms ahead. Targets come from `offsetLeft`/`offsetWidth`, never from transformed rects (the
 * tabs under the pill are bent toward it). Under reduced motion no spring runs: the pill jumps.
 */

export const LEAD_EDGE: SpringConfig = { stiffness: 420, damping: 30 };
export const TRAIL_EDGE: SpringConfig = { stiffness: 230, damping: 24 };
const PRESS_SPRING: SpringConfig = { stiffness: 380, damping: 22 };
/** Press and hold lifts the pill 6 % and squashes it 4 %. */
const PRESS_LIFT = 1.06;
const PRESS_SQUASH = 0.96;
const TRAVEL_LIFT = 1.04;
const TRAVEL_SHADOW = 'drop-shadow(0 6px 10px rgba(0,0,0,.28))';
const SHADOW_FROM_SCALE = 1.004; // the shadow shows while the pill is lifted more than this
const LANDED_PX = 1.5;
const TRAVEL_FROM_PX = 6; // a shorter move (both edges together) is not a travel: no lift
const MIN_WIDTH_PX = 8;
const HIGHLIGHT_LAG_S = 0.012; // seconds of the edges' mean velocity the highlight lags behind
const MAX_HIGHLIGHT_LAG_PX = 10;
const HOVER_LEAN_RATIO = 1 / 12; // the lean's share of the pointer's distance from the pill's centre
const MAX_LEAN_PX = 6;
const DRAG_FROM_PX = 5;
const RELEASE_PROJECTION_S = 0.08;
/** Tabs within this distance of the pill's centre lean toward it, rise and scale up. */
const BEND_REACH_PX = 80;
const BEND_LEAN_PX = 2;
const BEND_RISE_PX = 1;
const BEND_SCALE = 0.04;
const TAB_SELECTOR = '[role="tab"]';

export interface PillElements {
  /** The tablist: positioned, so the tabs' `offsetLeft` is measured from it. */
  readonly bar: HTMLElement;
  readonly pill: HTMLElement;
  readonly fill: HTMLElement;
  readonly highlight: HTMLElement;
}

/** A tab's left and right edges, centre and width, in the bar's layout pixels. */
type TabBox = Readonly<{ l: number; r: number; c: number; w: number }>;
type Layout = Readonly<{ width: number; tabs: readonly HTMLElement[]; boxes: readonly TabBox[] }>;
type Springs = Readonly<Record<'left' | 'right' | 'lift' | 'squash', Spring>>;

const px = (value: number) => `${value.toFixed(2)}px`;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function measure(bar: HTMLElement): Layout {
  const tabs = [...bar.querySelectorAll<HTMLElement>(TAB_SELECTOR)];
  const boxes = tabs.map((tab) => {
    const l = tab.offsetLeft;
    const w = tab.offsetWidth;
    return { l, r: l + w, c: l + w / 2, w };
  });
  return { width: bar.clientWidth, tabs, boxes };
}

function nearestTab(boxes: readonly TabBox[], x: number): number {
  return boxes.reduce(
    (best, box, index) => (Math.abs(box.c - x) < Math.abs((boxes[best]?.c ?? 0) - x) ? index : best),
    0,
  );
}

/** Tabs near the pill lean toward it and grow a little: the content under the drop is bent. */
function bend(tab: HTMLElement, box: TabBox, centre: number): void {
  const distance = (box.c - centre) / BEND_REACH_PX;
  const near = Math.max(0, 1 - Math.abs(distance));
  const lean = (-distance * BEND_LEAN_PX * near).toFixed(2);
  const rise = (-near * BEND_RISE_PX).toFixed(2);
  tab.style.transform = `translate3d(${lean}px,${rise}px,0) scale(${(1 + BEND_SCALE * near).toFixed(3)})`;
}

/** Draws the pill where its springs are. Returns whether the travel shadow is on now. */
function paint(elements: PillElements, layout: Layout, springs: Springs, hasShadow: boolean): boolean {
  const { pill, fill, highlight } = elements;
  const { left, right, lift, squash } = springs;
  const x = Math.min(left.x, right.x);
  const r = Math.max(left.x, right.x);
  const centre = x + Math.max(MIN_WIDTH_PX, r - x) / 2;
  const scale = lift.x;
  pill.style.clipPath = `inset(0 ${px(layout.width - r)} 0 ${px(x)} round 999px)`;
  fill.style.clipPath = `inset(1px ${px(layout.width - r + 1)} 1px ${px(x + 1)} round 999px)`;
  pill.style.transformOrigin = `${px(centre)} 50%`;
  pill.style.transform = `scale(${scale.toFixed(4)}, ${(squash.x * scale).toFixed(4)})`;
  const lag = clamp(-((left.v + right.v) / 2) * HIGHLIGHT_LAG_S, -MAX_HIGHLIGHT_LAG_PX, MAX_HIGHLIGHT_LAG_PX);
  highlight.style.transform = `translate3d(${px(centre - layout.width / 2 + lag)},0,0)`;
  const wantsShadow = scale > SHADOW_FROM_SCALE;
  // The filter is written only when it changes: a filter write costs a paint.
  if (wantsShadow !== hasShadow) pill.style.filter = wantsShadow ? TRAVEL_SHADOW : '';
  layout.tabs.forEach((tab, index) => {
    const box = layout.boxes[index];
    if (box !== undefined) bend(tab, box, centre);
  });
  return wantsShadow;
}

function capturePointer(bar: HTMLElement, pointerId: number): void {
  if (typeof bar.setPointerCapture !== 'function') return;
  try {
    bar.setPointerCapture(pointerId);
  } catch {
    // The pointer is already gone (lifted or cancelled): there is nothing to capture.
  }
}

/** The pill's motion over one tablist. Its springs are its own, mutated every frame, and never shared. */
class PillMotion {
  private readonly elements: PillElements;
  private readonly onSelect: (index: number) => void;
  private readonly springs: Springs = {
    left: createSpring(0, TRAIL_EDGE),
    right: createSpring(0, TRAIL_EDGE),
    lift: createSpring(1, PRESS_SPRING),
    squash: createSpring(1, PRESS_SPRING),
  };
  private readonly loop = createLoop((dt) => this.frame(dt));
  private readonly observer: ResizeObserver | null;
  private layout: Layout = { width: 0, tabs: [], boxes: [] };
  private active: number;
  /** The tab the user just picked (a click or a key): only that change travels. */
  private requested: number | null = null;
  private direction = 1;
  private isPressing = false;
  private isDraggingNow = false;
  private isTravelling = false;
  private hasShadow = false;
  private isDestroyed = false;
  private endPress: (() => void) | null = null;
  private dragEnd: ReturnType<typeof setTimeout> | null = null;

  constructor(elements: PillElements, active: number, onSelect: (index: number) => void) {
    this.elements = elements;
    this.active = active;
    this.onSelect = onSelect;
    this.remeasure();
    const { bar } = elements;
    bar.addEventListener('pointerdown', this.onPointerDown);
    bar.addEventListener('pointermove', this.onHover, { passive: true });
    bar.addEventListener('pointerleave', this.onLeave);
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(this.remeasure) : null;
    this.observer?.observe(bar);
    if (this.observer === null) window.addEventListener('resize', this.remeasure);
    // Web fonts change the tabs' widths once they load.
    document.fonts?.ready.then(() => {
      if (!this.isDestroyed) this.remeasure();
    });
  }

  /** The user picked tab `index`: when it becomes the active one, the pill travels there. */
  request(index: number): void {
    this.requested = index;
  }

  /**
   * Moves the pill to tab `index`. Motion answers an action (spec §11): it travels to the tab the user
   * picked, and jumps when the selection changed elsewhere (the route) or under reduced motion.
   */
  show(index: number): void {
    const isRequested = index === this.requested;
    this.requested = null;
    if (index === this.active) return;
    this.active = index;
    if (isRequested && !prefersReducedMotion()) {
      this.travelTo(index);
      return;
    }
    this.loop.stop();
    this.restOnActive();
  }

  /** From a drag's release until its click has passed: that click must not select a tab as well. */
  isDragging(): boolean {
    return this.isDraggingNow;
  }

  destroy(): void {
    this.isDestroyed = true;
    this.loop.stop();
    this.endPress?.();
    if (this.dragEnd !== null) clearTimeout(this.dragEnd);
    const { bar } = this.elements;
    bar.removeEventListener('pointerdown', this.onPointerDown);
    bar.removeEventListener('pointermove', this.onHover);
    bar.removeEventListener('pointerleave', this.onLeave);
    this.observer?.disconnect();
    window.removeEventListener('resize', this.remeasure);
  }

  private readonly remeasure = (): void => {
    this.layout = measure(this.elements.bar);
    this.elements.pill.style.width = `${this.layout.width}px`;
    this.restOnActive();
  };

  private draw(): void {
    this.hasShadow = paint(this.elements, this.layout, this.springs, this.hasShadow);
  }

  /** Puts the pill on the active tab, nothing moving, and draws it once. */
  private restOnActive(): void {
    const { left, right, lift, squash } = this.springs;
    const box = this.layout.boxes[this.active];
    if (box !== undefined) {
      left.set(box.l);
      right.set(box.r);
    }
    lift.set(1);
    squash.set(1);
    this.isTravelling = false;
    this.draw();
  }

  private frame(dt: number): boolean {
    if (prefersReducedMotion()) {
      this.restOnActive();
      return false;
    }
    const { left, right, lift, squash } = this.springs;
    const isMoving = [left.step(dt), right.step(dt), squash.step(dt), lift.step(dt)].some(Boolean);
    const hasLanded =
      Math.abs(left.target - left.x) < LANDED_PX && Math.abs(right.target - right.x) < LANDED_PX;
    if (this.isTravelling && !this.isPressing && hasLanded) {
      this.isTravelling = false;
      lift.target = 1;
    }
    this.draw();
    return isMoving || this.isPressing;
  }

  private aim(l: number, r: number, isTravel: boolean): void {
    const { left, right, lift } = this.springs;
    this.direction = Math.sign((l + r) / 2 - (left.x + right.x) / 2) || this.direction;
    // The edge facing the destination leads.
    retune(this.direction > 0 ? right : left, LEAD_EDGE);
    retune(this.direction > 0 ? left : right, TRAIL_EDGE);
    left.target = l;
    right.target = r;
    if (isTravel && Math.abs(l - left.x) + Math.abs(r - right.x) > TRAVEL_FROM_PX) {
      this.isTravelling = true;
      if (!this.isPressing) lift.target = TRAVEL_LIFT;
    }
    this.loop.start();
  }

  private travelTo(index: number): void {
    const box = this.layout.boxes[index];
    if (box !== undefined) this.aim(box.l, box.r, true);
  }

  /** The pointer's x in the bar's layout pixels, undoing any scale on the bar. */
  private pointerX(event: PointerEvent): number {
    const { bar } = this.elements;
    const rect = bar.getBoundingClientRect();
    const scale = rect.width > 0 ? bar.offsetWidth / rect.width : 1;
    return (event.clientX - rect.left) * scale;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // Only a primary press: a right or ctrl click's release goes to a context menu, not to the page.
    const isPress = event.button === 0 && event.isPrimary && !event.ctrlKey;
    if (!isPress || prefersReducedMotion() || this.layout.boxes[this.active] === undefined) return;
    this.endPress?.();
    const { bar } = this.elements;
    const { lift, squash } = this.springs;
    const startX = event.clientX;
    this.isPressing = true;
    this.isDraggingNow = false;
    lift.target = PRESS_LIFT;
    squash.target = PRESS_SQUASH;
    this.loop.start();
    const onMove = (move: PointerEvent) => {
      if (!this.isDraggingNow) {
        if (Math.abs(move.clientX - startX) < DRAG_FROM_PX) return;
        this.isDraggingNow = true;
        capturePointer(bar, event.pointerId);
      }
      const x = this.pointerX(move);
      const half = (this.layout.boxes[this.active]?.w ?? 0) / 2;
      this.aim(x - half, x + half, false);
    };
    const onUp = () => {
      this.endPress?.();
      this.onPressEnd();
    };
    // The release is heard on the window: it can come off the bar, before any capture began.
    this.endPress = () => {
      bar.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      this.endPress = null;
    };
    bar.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  private onPressEnd(): void {
    const { left, right, lift, squash } = this.springs;
    this.isPressing = false;
    lift.target = 1;
    squash.target = 1;
    if (this.isDraggingNow) {
      const projected = (left.x + right.x) / 2 + ((left.v + right.v) / 2) * RELEASE_PROJECTION_S;
      const index = nearestTab(this.layout.boxes, projected);
      const isChanged = index !== this.active;
      this.active = index;
      this.travelTo(index);
      if (isChanged) this.onSelect(index);
      this.dragEnd = setTimeout(() => {
        this.isDraggingNow = false;
        this.dragEnd = null;
      }, 0);
    }
    this.loop.start();
  }

  /** Aims the resting pill `lean` px off its tab: toward the pointer on hover, 0 when it leaves. */
  private leanBy(lean: (box: TabBox) => number): void {
    const box = this.layout.boxes[this.active];
    if (this.isPressing || prefersReducedMotion() || box === undefined) return;
    const offset = lean(box);
    this.springs.left.target = box.l + offset;
    this.springs.right.target = box.r + offset;
    this.loop.start();
  }

  private readonly onHover = (event: PointerEvent): void => {
    if (this.isTravelling) return;
    this.leanBy((box) => clamp((this.pointerX(event) - box.c) * HOVER_LEAN_RATIO, -MAX_LEAN_PX, MAX_LEAN_PX));
  };

  private readonly onLeave = (): void => this.leanBy(() => 0);
}

export interface LiquidPill {
  readonly barRef: RefObject<HTMLDivElement | null>;
  readonly pillRef: RefObject<HTMLSpanElement | null>;
  readonly fillRef: RefObject<HTMLSpanElement | null>;
  readonly highlightRef: RefObject<HTMLSpanElement | null>;
  /** Selects tab `index` for the user's click or key: calls `onSelect`, and the pill travels there. */
  readonly select: (index: number) => void;
  /** True from a drag's release until its click has passed: that click must not select. */
  readonly isDragging: () => boolean;
}

/**
 * The liquid pill over the tabs (`role="tab"`) inside `barRef`, resting on tab `active`. A drag that
 * ends on another tab calls `onSelect` with its index, as `select` does; the pill follows `active`.
 */
export function useLiquidPill(active: number, onSelect: (index: number) => void): LiquidPill {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const motionRef = useRef<PillMotion | null>(null);
  const onSelectRef = useRef(onSelect);

  // Layout effects: the pill is measured and drawn before the first paint, so it never shows unclipped.
  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
  });

  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    const fill = fillRef.current;
    const highlight = highlightRef.current;
    if (bar === null || pill === null || fill === null || highlight === null) return;
    // It starts on the first tab; the effect below puts it on the active one, without motion.
    const motion = new PillMotion({ bar, pill, fill, highlight }, 0, (index) => onSelectRef.current(index));
    motionRef.current = motion;
    return () => {
      motion.destroy();
      motionRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    motionRef.current?.show(active);
  }, [active]);

  const select = useCallback((index: number) => {
    motionRef.current?.request(index);
    onSelectRef.current(index);
  }, []);
  const isDragging = useCallback(() => motionRef.current?.isDragging() ?? false, []);
  return { barRef, pillRef, fillRef, highlightRef, select, isDragging };
}
