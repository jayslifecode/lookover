import { prefersReducedMotion } from './reduced';

/*
 * The pin → panel container transform (spec §11, ported from the motion study's `growFromPin`): a copy
 * of the panel, already rendered with the new finding (the ghost), grows out of the clicked pin with
 * `transform` and `clip-path` (round 999px → 18px over 560 ms) while its content fades in from 28 % to
 * 70 % of the way and the panel's old content fades out in 130 ms. When the ghost lands the real content
 * is swapped in and the ghost fades out in 150 ms. The panel's glass never moves, resizes or changes its
 * filter, and the ghost is a solid tint with no backdrop blur, so the glass budget holds throughout.
 *
 * The caller renders the ghost (a React element in the stage) and swaps the content; this module only
 * places and animates. One transform runs at a time: a new one, or `cancel`, lands the running one at
 * once (its content swapped in, its ghost gone). Under reduced motion, or without the Web Animations
 * API, nothing animates and the content is swapped at once.
 */

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface GrowFromPinOptions {
  /** The clicked pin, in viewport coordinates. */
  readonly pinRect: Rect;
  /** The panel the ghost lands on, in viewport coordinates. */
  readonly panelRect: Rect;
  /** The positioned element the ghost is placed in. */
  readonly stage: HTMLElement;
  /** The panel's copy holding the new finding, inside `stage`; its first child is the content that fades in. */
  readonly ghost: HTMLElement;
  /** The panel's current content, which fades out. */
  readonly body: HTMLElement | null;
  /** Swap the new finding into the real panel. */
  readonly onArrive: () => void;
  /** The ghost has done its work: remove it. */
  readonly onDone: () => void;
}

export interface ContainerTransform {
  /** Lands the transform at once (content swapped, ghost removed); nothing more runs. */
  cancel(): void;
}

export const GROW_MS = 560;
export const BODY_OUT_MS = 130;
export const GHOST_OUT_MS = 150;
const DECIMALS = 4;
/** How much of the way the ghost has come at the middle keyframe, across and down (the study's values). */
const MID_TRAVEL = 0.86;
const MID_SCALE_X = 0.88;
const MID_SCALE_Y = 0.84;
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
const EASE_SPRING = 'cubic-bezier(.22,1.2,.36,1)';
const CONTENT_IN: Keyframe[] = [
  { opacity: 0 },
  { opacity: 0, offset: 0.28 },
  { opacity: 1, offset: 0.7 },
  { opacity: 1 },
];
const BODY_OUT: Keyframe[] = [
  { opacity: 1, transform: 'none' },
  { opacity: 0, transform: 'translateY(-4px)' },
];
const GHOST_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];

function rounded(value: number): number {
  return Number(value.toFixed(DECIMALS));
}

function transformOf(dx: number, dy: number, sx: number, sy: number): string {
  return `translate3d(${rounded(dx)}px, ${rounded(dy)}px, 0) scale(${rounded(sx)}, ${rounded(sy)})`;
}

/** The transform that lays the panel's box over the pin's: the ghost's first keyframe. */
export function startTransform(pinRect: Rect, panelRect: Rect): string {
  return transformOf(
    pinRect.left - panelRect.left,
    pinRect.top - panelRect.top,
    pinRect.width / panelRect.width,
    pinRect.height / panelRect.height,
  );
}

function growKeyframes(pinRect: Rect, panelRect: Rect): Keyframe[] {
  const dx = pinRect.left - panelRect.left;
  const dy = pinRect.top - panelRect.top;
  const sx = pinRect.width / panelRect.width;
  const sy = pinRect.height / panelRect.height;
  const left = 1 - MID_TRAVEL;
  return [
    { transform: startTransform(pinRect, panelRect), clipPath: 'inset(0 round 999px)', easing: EASE_OUT },
    {
      transform: transformOf(dx * left, dy * left, sx + (1 - sx) * MID_SCALE_X, sy + (1 - sy) * MID_SCALE_Y),
      clipPath: 'inset(0 round 34px)',
      offset: 0.5,
      easing: EASE_SPRING,
    },
    { transform: 'none', clipPath: 'inset(0 round 18px)' },
  ];
}

/** Places the ghost over the panel, in the stage's coordinates. Set once, before anything moves. */
function placeGhost({ ghost, stage, panelRect }: GrowFromPinOptions): void {
  const stageRect = stage.getBoundingClientRect();
  ghost.style.left = `${panelRect.left - stageRect.left}px`;
  ghost.style.top = `${panelRect.top - stageRect.top}px`;
  ghost.style.width = `${panelRect.width}px`;
  ghost.style.height = `${panelRect.height}px`;
}

/** Swallows the rejection of an animation's `finished` once it is cancelled. */
function ignoreCancel(): void {}

let running: ContainerTransform | null = null;

/** Grows the ghost out of the pin onto the panel (see the module comment). */
export function growFromPin(options: GrowFromPinOptions): ContainerTransform {
  running?.cancel();
  const { ghost, body, onArrive, onDone } = options;
  if (prefersReducedMotion() || typeof ghost.animate !== 'function') {
    onArrive();
    onDone();
    return { cancel: () => undefined };
  }

  placeGhost(options);
  const fadeOut = body?.animate(BODY_OUT, { duration: BODY_OUT_MS, easing: 'ease-out', fill: 'forwards' });
  const grow = ghost.animate(growKeyframes(options.pinRect, options.panelRect), {
    duration: GROW_MS,
    fill: 'forwards',
  });
  const content = ghost.firstElementChild;
  const fadeIn = content?.animate(CONTENT_IN, { duration: GROW_MS, fill: 'forwards' });
  let leave: Animation | null = null;
  let frame: number | null = null;
  let hasArrived = false;
  let isOver = false;

  const finish = () => {
    if (isOver) return;
    isOver = true;
    if (running === transform) running = null;
    onDone();
  };
  // The old body stays faded until the swapped-in content has had a frame to render, then shows it.
  const showBody = () => {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        fadeOut?.cancel();
      });
    });
  };
  const arrive = () => {
    if (isOver || hasArrived) return;
    hasArrived = true;
    onArrive();
    showBody();
    leave = ghost.animate(GHOST_OUT, { duration: GHOST_OUT_MS, fill: 'forwards' });
    leave.finished.then(finish, ignoreCancel);
  };
  const transform: ContainerTransform = {
    cancel() {
      if (isOver) return;
      for (const animation of [grow, fadeIn, fadeOut, leave]) animation?.cancel();
      if (frame !== null) cancelAnimationFrame(frame);
      if (!hasArrived) {
        hasArrived = true;
        onArrive();
      }
      finish();
    },
  };
  grow.finished.then(arrive, ignoreCancel);
  running = transform;
  return transform;
}
