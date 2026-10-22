import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  BODY_OUT_MS,
  GHOST_OUT_MS,
  GROW_MS,
  type GrowFromPinOptions,
  growFromPin,
  type Rect,
  startTransform,
} from '../src/motion/container-transform';
import { REDUCED_MOTION, stubMatchMedia } from './media';

/*
 * The pin → panel container transform (spec §11), driven with a stand-in for the Web Animations API
 * (jsdom has none): each `animate` call is recorded with its element, keyframes and options, and its
 * `finished` promise settles when the test says so, as a browser's does when the animation ends.
 */

interface FakeAnimation {
  readonly element: Element;
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly cancel: ReturnType<typeof vi.fn>;
  finish(): Promise<void>;
}

let animations: FakeAnimation[] = [];

function stubAnimate(): void {
  animations = [];
  const animate = vi.fn(function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const finished = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // As in a browser, the rejection a cancel causes is marked as handled.
    finished.catch(() => undefined);
    const animation: FakeAnimation = {
      element: this,
      keyframes,
      options,
      cancel: vi.fn(() => reject(new DOMException('The animation was cancelled', 'AbortError'))),
      finish: async () => {
        resolve();
        // Let the code waiting on `finished` run.
        await Promise.resolve();
        await Promise.resolve();
      },
    };
    animations.push(animation);
    return { finished, cancel: animation.cancel } as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    value: animate,
    configurable: true,
    writable: true,
  });
}

const PIN: Rect = { left: 100, top: 200, width: 40, height: 40 };
const PANEL: Rect = { left: 1000, top: 84, width: 400, height: 800 };
const STAGE: Rect = { left: 20, top: 4, width: 1400, height: 2000 };

function rectOf({ left, top, width, height }: Rect): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect;
}

interface Scene {
  readonly options: GrowFromPinOptions;
  readonly ghost: HTMLElement;
  readonly content: HTMLElement;
  readonly body: HTMLElement;
  readonly onArrive: ReturnType<typeof vi.fn>;
  readonly onDone: ReturnType<typeof vi.fn>;
}

/** A stage holding the ghost (with its content) and the panel's body, as the Screens view renders them. */
function scene(): Scene {
  const stage = document.createElement('div');
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(rectOf(STAGE));
  const ghost = document.createElement('div');
  const content = document.createElement('div');
  ghost.append(content);
  const body = document.createElement('div');
  stage.append(ghost, body);
  document.body.append(stage);
  const onArrive = vi.fn();
  const onDone = vi.fn();
  return {
    options: { pinRect: PIN, panelRect: PANEL, stage, ghost, body, onArrive, onDone },
    ghost,
    content,
    body,
    onArrive,
    onDone,
  };
}

function animationOf(element: Element, index = 0): FakeAnimation {
  const found = animations.filter((animation) => animation.element === element)[index];
  if (found === undefined) throw new Error('The element was not animated');
  return found;
}

/** Runs the animation frames requested so far. */
function runFrames(): void {
  vi.runOnlyPendingTimers();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  stubAnimate();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  document.body.replaceChildren();
});

test('the start transform maps the panel onto the pin: a translation to its corner and a scale to its size', () => {
  expect(startTransform(PIN, PANEL)).toBe('translate3d(-900px, 116px, 0) scale(0.1, 0.05)');
  expect(startTransform(PANEL, PANEL)).toBe('translate3d(0px, 0px, 0) scale(1, 1)');
  // Long fractions are cut to four places.
  expect(
    startTransform({ left: 0, top: 0, width: 24, height: 24 }, { ...PANEL, left: 0, top: 0, width: 380 }),
  ).toBe('translate3d(0px, 0px, 0) scale(0.0632, 0.03)');
});

test('the ghost sits over the panel and grows out of the pin: clip-path 999px → 18px over 560 ms, its content in from 28 % to 70 %, the old body out in 130 ms', () => {
  const { options, ghost, content, body, onArrive } = scene();
  growFromPin(options);

  // Placed on the panel, inside the stage; the transform starts it on the pin.
  expect([ghost.style.left, ghost.style.top, ghost.style.width, ghost.style.height]).toEqual([
    '980px',
    '80px',
    '400px',
    '800px',
  ]);
  const grow = animationOf(ghost);
  expect(grow.options).toMatchObject({ duration: GROW_MS, fill: 'forwards' });
  expect(grow.keyframes.map((frame) => frame.transform)).toEqual([
    startTransform(PIN, PANEL),
    expect.stringMatching(/^translate3d\(-126px, 16\.24px, 0\) scale\(0\.892, 0\.848\)$/),
    'none',
  ]);
  expect(grow.keyframes.map((frame) => frame.clipPath)).toEqual([
    'inset(0 round 999px)',
    'inset(0 round 34px)',
    'inset(0 round 18px)',
  ]);
  // Only compositor properties move.
  const moved = new Set(grow.keyframes.flatMap((frame) => Object.keys(frame)));
  expect([...moved].every((key) => ['transform', 'clipPath', 'offset', 'easing'].includes(key))).toBe(true);

  const fadeIn = animationOf(content);
  expect(fadeIn.options).toMatchObject({ duration: GROW_MS });
  expect(fadeIn.keyframes).toEqual([
    { opacity: 0 },
    { opacity: 0, offset: 0.28 },
    { opacity: 1, offset: 0.7 },
    { opacity: 1 },
  ]);
  const fadeOut = animationOf(body);
  expect(fadeOut.options).toMatchObject({ duration: BODY_OUT_MS, fill: 'forwards' });
  expect(fadeOut.keyframes.at(-1)).toMatchObject({ opacity: 0 });
  expect(onArrive).not.toHaveBeenCalled();
});

test('on arrival the real content is swapped in, the old body comes back once it holds it, and the ghost fades out in 150 ms and goes', async () => {
  const { options, ghost, body, onArrive, onDone } = scene();
  growFromPin(options);

  await animationOf(ghost).finish();

  expect(onArrive).toHaveBeenCalledTimes(1);
  const fade = animationOf(ghost, 1);
  expect(fade.options).toMatchObject({ duration: GHOST_OUT_MS, fill: 'forwards' });
  expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  // The body stays faded until the new content has had a frame to render, then shows it.
  expect(animationOf(body).cancel).not.toHaveBeenCalled();
  runFrames();
  runFrames();
  expect(animationOf(body).cancel).toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();

  await fade.finish();
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onArrive).toHaveBeenCalledTimes(1);
});

test('under reduced motion nothing runs: the new content is swapped in at once and the ghost goes', () => {
  stubMatchMedia({ [REDUCED_MOTION]: true });
  const { options, onArrive, onDone } = scene();

  growFromPin(options);

  expect(animations).toEqual([]);
  expect(onArrive).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test('a second transform cancels the first: its ghost goes and its finding is swapped in at once', async () => {
  const first = scene();
  const second = scene();
  growFromPin(first.options);
  const firstGrow = animationOf(first.ghost);

  growFromPin(second.options);

  expect(firstGrow.cancel).toHaveBeenCalled();
  expect(animationOf(first.content).cancel).toHaveBeenCalled();
  expect(animationOf(first.body).cancel).toHaveBeenCalled();
  expect(first.onArrive).toHaveBeenCalledTimes(1);
  expect(first.onDone).toHaveBeenCalledTimes(1);
  // The second runs on.
  expect(animationOf(second.ghost).cancel).not.toHaveBeenCalled();
  expect(second.onArrive).not.toHaveBeenCalled();

  // Nothing of the first comes back later.
  await firstGrow.finish();
  expect(first.onArrive).toHaveBeenCalledTimes(1);
  expect(first.onDone).toHaveBeenCalledTimes(1);
});

test('a transform cancelled by its caller swaps at once and runs nothing more', async () => {
  const { options, ghost, onArrive, onDone } = scene();
  const transform = growFromPin(options);

  transform.cancel();
  transform.cancel();

  expect(onArrive).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledTimes(1);
  await animationOf(ghost).finish();
  expect(onArrive).toHaveBeenCalledTimes(1);
});
