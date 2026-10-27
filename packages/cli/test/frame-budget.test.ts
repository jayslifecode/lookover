import { describe, expect, test } from 'vitest';
import { FRAME_BUDGET_ENV, FRAME_BUDGET_MS, frameBudget, frameStats, recordOnlyLine } from './e2e/frames.js';

describe("the report's frame budget in the end-to-end suite", () => {
  test('is 34 ms and recorded only, unless LOOKOVER_FRAME_BUDGET_MS sets it', () => {
    const recorded = frameBudget({});

    expect(FRAME_BUDGET_ENV).toBe('LOOKOVER_FRAME_BUDGET_MS');
    expect(recorded).toEqual({ ms: FRAME_BUDGET_MS, isAsserted: false });
    expect(frameBudget({ [FRAME_BUDGET_ENV]: '  ' })).toEqual(recorded);
    expect(recordOnlyLine(recorded)).toBe(
      "frame budget: 34 ms is recorded, not asserted, until a CI runner's numbers have been seen; set LOOKOVER_FRAME_BUDGET_MS to assert it",
    );
  });

  test('set, replaces 34 ms and is asserted', () => {
    const asserted = frameBudget({ [FRAME_BUDGET_ENV]: '50' });

    expect(asserted).toEqual({ ms: 50, isAsserted: true });
    expect(recordOnlyLine(asserted)).toBeNull();
    expect(frameStats([16.7, 40, 51, 70], asserted.ms)).toMatchObject({ overBudget: 2, overHardLimit: 1 });
  });

  test.each(['fast', '0', '-16', 'Infinity'])('refuses %s', (value) => {
    expect(() => frameBudget({ [FRAME_BUDGET_ENV]: value })).toThrow(
      `LOOKOVER_FRAME_BUDGET_MS must be a number of milliseconds above 0, not "${value}"`,
    );
  });
});
