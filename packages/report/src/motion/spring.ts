/*
 * The spec's spring integrator (§11 Motion), ported from the motion study's `spring` and `loop`:
 * semi-implicit Euler, stepped twice per animation frame, with a frame never longer than 32 ms (a tab
 * that was in the background resumes where it was instead of jumping). Interruptible and
 * velocity-carrying: a new target mid-flight keeps the current velocity, which keyframes cannot do.
 *
 * A spring is the one deliberately mutable object of the report: the animation that owns it steps it
 * every frame, and nothing else holds it.
 */

export interface SpringConfig {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass?: number;
}

export interface Spring {
  x: number;
  v: number;
  target: number;
  stiffness: number;
  damping: number;
  mass: number;
  /** Advances `dt` seconds; `false` once the spring is at rest, sitting exactly on its target. */
  step(dt: number): boolean;
  /** Jumps to `x` with velocity `v` and makes `x` the target. */
  set(x: number, v?: number): void;
}

/** Below this speed and this distance from the target, a spring is at rest. */
export const REST_DELTA = 0.02;
const DEFAULT_SPRING: SpringConfig = { stiffness: 300, damping: 26, mass: 1 };
const DEFAULT_MASS = 1;

export function createSpring(value: number, config: SpringConfig = DEFAULT_SPRING): Spring {
  const spring: Spring = {
    x: value,
    v: 0,
    target: value,
    stiffness: config.stiffness,
    damping: config.damping,
    mass: config.mass ?? DEFAULT_MASS,
    step(dt) {
      const acceleration =
        (spring.stiffness * (spring.target - spring.x) - spring.damping * spring.v) / spring.mass;
      spring.v += acceleration * dt;
      spring.x += spring.v * dt;
      const isMoving = Math.abs(spring.v) > REST_DELTA || Math.abs(spring.target - spring.x) > REST_DELTA;
      if (!isMoving) spring.set(spring.target);
      return isMoving;
    },
    set(x, v = 0) {
      spring.x = x;
      spring.v = v;
      spring.target = x;
    },
  };
  return spring;
}

/** Gives `spring` another stiffness and damping, keeping where it is and how fast it goes. */
export function retune(spring: Spring, config: SpringConfig): void {
  spring.stiffness = config.stiffness;
  spring.damping = config.damping;
  spring.mass = config.mass ?? DEFAULT_MASS;
}

/** Where frames come from: the browser's animation frames, or a test's clock. */
export interface FrameClock {
  now(): number;
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

export interface Loop {
  /** Starts asking for frames, unless it already does. */
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export const MAX_FRAME_S = 0.032;
export const SUBSTEPS_PER_FRAME = 2;
const MS_PER_S = 1000;

const ANIMATION_FRAMES: FrameClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Calls `fn` with the time step, twice per frame, for as long as one of the calls returns `true` (still
 * moving); then stops asking for frames until `start` is called again.
 */
export function createLoop(fn: (dt: number) => boolean, clock: FrameClock = ANIMATION_FRAMES): Loop {
  let last = 0;
  let frame: number | null = null;
  const tick = (time: number) => {
    const dt = Math.min(MAX_FRAME_S, Math.max(0, (time - last) / MS_PER_S));
    last = time;
    let isAlive = false;
    for (let substep = 0; substep < SUBSTEPS_PER_FRAME; substep++) {
      isAlive = fn(dt / SUBSTEPS_PER_FRAME) || isAlive;
    }
    frame = isAlive ? clock.request(tick) : null;
  };
  return {
    start() {
      if (frame !== null) return;
      last = clock.now();
      frame = clock.request(tick);
    },
    stop() {
      if (frame === null) return;
      clock.cancel(frame);
      frame = null;
    },
    isRunning: () => frame !== null,
  };
}
