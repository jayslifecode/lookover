// @vitest-environment node
import { expect, test } from 'vitest';
import { createLoop, createSpring, type FrameClock, MAX_FRAME_S, type Spring } from '../src/motion/spring';
import { LEAD_EDGE, TRAIL_EDGE } from '../src/motion/use-liquid-pill';

const FRAME_MS = 1000 / 60;
const SETTLE_BY_MS = 650;
const SETTLED_PX = 0.5;
const MAX_OVERSHOOT = 0.02;
/** A three-tab jump: the pill [0, 100] goes to [300, 400]; the right edge faces the destination and leads. */
const FROM = { l: 0, r: 100 };
const TO = { l: 300, r: 400 };
const TRAVEL = TO.l - FROM.l;

/** A frame clock that runs only when told to, at exactly 60 frames a second. */
function manualClock(): FrameClock & {
  runFrames(count: number, frameMs?: number): void;
  readonly pending: number;
} {
  let now = 0;
  let next = 1;
  const callbacks = new Map<number, (time: number) => void>();
  return {
    now: () => now,
    request(callback) {
      const handle = next++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
    runFrames(count, frameMs = FRAME_MS) {
      for (let frame = 0; frame < count && callbacks.size > 0; frame++) {
        now += frameMs;
        const due = [...callbacks.values()];
        callbacks.clear();
        for (const callback of due) callback(now);
      }
    },
    get pending() {
      return callbacks.size;
    },
  };
}

interface Trace {
  readonly ms: number;
  readonly left: number;
  readonly right: number;
}

function pillEdges(): { left: Spring; right: Spring } {
  const left = createSpring(FROM.l, TRAIL_EDGE);
  const right = createSpring(FROM.r, LEAD_EDGE);
  left.target = TO.l;
  right.target = TO.r;
  return { left, right };
}

/** The integrator alone, one step of 1/60 s each 60th of a second. */
function integratorTrace(seconds: number): Trace[] {
  const { left, right } = pillEdges();
  return Array.from({ length: Math.round(seconds * 60) }, (_, index) => {
    left.step(1 / 60);
    right.step(1 / 60);
    return { ms: (index + 1) * FRAME_MS, left: left.x, right: right.x };
  });
}

/** The frame loop the pill runs on, at 60 frames a second: two substeps per frame. */
function loopTrace(seconds: number): { trace: Trace[]; restedAtMs: number | null } {
  const { left, right } = pillEdges();
  const clock = manualClock();
  const trace: Trace[] = [];
  let restedAtMs: number | null = null;
  let substeps = 0;
  const loop = createLoop((dt) => {
    const isMoving = [left.step(dt), right.step(dt)].some(Boolean);
    substeps += 1;
    if (substeps % 2 === 0) trace.push({ ms: (substeps / 2) * FRAME_MS, left: left.x, right: right.x });
    if (!isMoving && restedAtMs === null) restedAtMs = (substeps / 2) * FRAME_MS;
    return isMoving;
  }, clock);
  loop.start();
  clock.runFrames(Math.round(seconds * 60));
  expect(clock.pending).toBe(0);
  return { trace, restedAtMs };
}

function settledBy(trace: readonly Trace[]): number {
  const last = trace.findLastIndex(
    (point) => Math.abs(point.left - TO.l) > SETTLED_PX || Math.abs(point.right - TO.r) > SETTLED_PX,
  );
  return last === -1 ? 0 : (trace[last]?.ms ?? 0) + FRAME_MS;
}

function overshoot(trace: readonly Trace[]): number {
  const furthest = Math.max(...trace.map((point) => Math.max(point.left - TO.l, point.right - TO.r)));
  return Math.max(0, furthest) / TRAVEL;
}

test.each([
  ['the integrator at 60 steps a second', () => integratorTrace(2)],
  ['the frame loop at 60 frames a second', () => loopTrace(2).trace],
])('%s: both edges settle within 650 ms and overshoot by under 2 percent of the travel', (_, run) => {
  const trace = run();
  expect(settledBy(trace)).toBeLessThanOrEqual(SETTLE_BY_MS);
  expect(overshoot(trace)).toBeLessThan(MAX_OVERSHOOT);
});

test('the leading edge gets there first, so the pill stretches on the way', () => {
  const { trace } = loopTrace(2);
  const widest = Math.max(...trace.map((point) => point.right - point.left));
  expect(widest / (FROM.r - FROM.l)).toBeGreaterThan(1.4);
  const halfway = trace.find((point) => point.right - FROM.r >= TRAVEL / 2);
  expect(halfway === undefined ? 0 : halfway.left - FROM.l).toBeLessThan(TRAVEL / 2);
});

test('the loop comes to rest on its own and stops asking for frames', () => {
  const { restedAtMs } = loopTrace(3);
  expect(restedAtMs).not.toBeNull();
  expect(restedAtMs ?? Number.POSITIVE_INFINITY).toBeLessThan(1500);
});

test('a long frame advances at most 32 ms, in two substeps', () => {
  const clock = manualClock();
  const steps: number[] = [];
  const loop = createLoop((dt) => {
    steps.push(dt);
    return true;
  }, clock);
  loop.start();
  clock.runFrames(1);
  expect(steps).toHaveLength(2);
  for (const dt of steps) expect(dt).toBeCloseTo(FRAME_MS / 2000, 12);

  // The tab was in the background: the next frame comes 500 ms later.
  clock.runFrames(1, 500);
  expect(steps.slice(2)).toEqual([MAX_FRAME_S / 2, MAX_FRAME_S / 2]);
  loop.stop();
});

test('start is idempotent while running, stop cancels the frame, and set jumps without velocity', () => {
  const clock = manualClock();
  const loop = createLoop(() => true, clock);
  loop.start();
  loop.start();
  expect(clock.pending).toBe(1);
  expect(loop.isRunning()).toBe(true);
  loop.stop();
  expect(clock.pending).toBe(0);
  expect(loop.isRunning()).toBe(false);

  const spring = createSpring(0, LEAD_EDGE);
  spring.target = 100;
  spring.step(1 / 60);
  expect(spring.v).toBeGreaterThan(0);
  spring.set(50);
  expect({ x: spring.x, v: spring.v, target: spring.target }).toEqual({ x: 50, v: 0, target: 50 });
  expect(spring.step(1 / 60)).toBe(false);
});
