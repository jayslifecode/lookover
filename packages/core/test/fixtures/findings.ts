import type { EvidenceRef } from '../../src/evidence/store.js';
import type {
  ElementTarget,
  EvidenceItem,
  FindingsFile,
  Occurrence,
  OccurrenceFinding,
  StepFinding,
} from '../../src/findings/types.js';
import type { Box, Viewport } from '../../src/map/types.js';

export const BOX: Box = { x: 10, y: 20, width: 120, height: 40 };
export const DESKTOP: Viewport = { name: 'desktop', width: 1280, height: 800 };
export const MOBILE: Viewport = { name: 'mobile', width: 390, height: 844 };

export const SAVE_BUTTON: ElementTarget = {
  selector: 'button[type="submit"]',
  role: 'button',
  name: 'Save',
  componentName: 'SettingsForm',
  signature: 'button.btn.primary',
  box: BOX,
};

export function evidenceItem(id: string, label = `evidence ${id}`): EvidenceItem {
  const ref: EvidenceRef = { id, path: `evidence/${id}.png`, bytes: 100, kind: 'png' };
  return { kind: 'screenshot', label, ref };
}

export function occurrence(
  screenId: string,
  selector: string | null,
  overrides: Partial<Occurrence> = {},
): Occurrence {
  return {
    screenId,
    route: '/settings',
    url: 'http://localhost:3123/settings',
    viewport: DESKTOP,
    selector,
    measured: { count: 1 },
    ...overrides,
  };
}

export function occurrenceFinding(overrides: Partial<OccurrenceFinding> = {}): OccurrenceFinding {
  return {
    shape: 'occurrence',
    id: 'occ-finding-1',
    key: 'Failed to load resource',
    source: 'observers',
    rule: { id: 'observers.console-error', source: 'catalogue' },
    severity: 'high',
    status: 'candidate',
    judgement: null,
    title: 'The page logged an error',
    expected: 'The console stays free of errors.',
    observed: 'logged "Failed to load resource" 1 time',
    whyItMatters: 'An error in the console is usually something that does not work.',
    evidence: [],
    fixPrompt: 'In /settings (http://localhost:3123/settings), logged an error.',
    createdAt: '2026-10-21T12:00:00.000Z',
    occurrences: [],
    ...overrides,
  };
}

export function stepFinding(overrides: Partial<StepFinding> = {}): StepFinding {
  return {
    shape: 'step',
    id: 'step-finding-1',
    key: '/settings|button[type="submit"]',
    source: 'interaction',
    rule: { id: 'interaction.focus-visible-missing', source: 'catalogue' },
    severity: 'high',
    status: 'candidate',
    judgement: null,
    title: 'Keyboard focus is not visible',
    expected: 'The focused control shows a clear outline.',
    observed: 'shows no change when it receives keyboard focus',
    whyItMatters: 'People who use a keyboard need to see where they are.',
    evidence: [],
    fixPrompt: 'In /settings (http://localhost:3123/settings), the button "Save" shows no change.',
    createdAt: '2026-10-21T12:00:00.000Z',
    screenId: 'screen-1',
    target: SAVE_BUTTON,
    trace: {
      route: '/settings',
      url: 'http://localhost:3123/settings',
      viewport: DESKTOP,
      steps: [{ kind: 'navigate', url: 'http://localhost:3123/settings' }],
    },
    ...overrides,
  };
}

export function findingsFile(overrides: Partial<FindingsFile> = {}): FindingsFile {
  return {
    version: 2,
    runId: 'run-1',
    createdAt: '2026-10-21T12:00:00.000Z',
    findings: [],
    worthALook: [],
    rejected: [],
    intended: [],
    judge: null,
    environment: null,
    ...overrides,
  };
}

/** Freezes `value` and everything inside it, so a function that mutates its input throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
