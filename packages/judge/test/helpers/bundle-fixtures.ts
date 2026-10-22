import {
  type Attempt,
  type Environment,
  type EvidenceItem,
  type EvidenceRef,
  type OccurrenceFinding,
  occurrenceFinding,
  type StepFinding,
  stepFinding,
  type Viewport,
} from '@jayslifecode/lookover-core';
import { ruleById } from '@jayslifecode/lookover-rules';

export const FOCUS_VISIBLE = ruleById('interaction.focus-visible-missing');
export const CONSOLE_ERROR = ruleById('observers.console-error');
export const MODEL = 'claude-sonnet-5-5';
export const CREATED_AT = '2026-10-22T09:00:00.000Z';
export const VIEWPORT: Viewport = { name: 'desktop', width: 1280, height: 800 };
export const SETTINGS_URL = 'http://localhost:3123/settings';
export const SAVE_SELECTOR = '[data-testid="settings-save"]';
export const FOCUS_OBSERVED = 'shows no change when it receives keyboard focus';
export const FOCUS_STYLES = 'computed styles of the control, before and after focus';

export const ENVIRONMENT: Environment = {
  browser: 'chromium 141.0.7390.37',
  os: 'darwin 25.0.0 arm64',
  node: 'v24.4.0',
  lookover: '0.0.0-test',
  viewport: VIEWPORT,
};

/** One stored evidence file: its ref, and the bytes the reader hands back for it. */
export interface StoredEvidence {
  readonly item: EvidenceItem;
  readonly data: Buffer;
}

function refOf(id: string, kind: EvidenceRef['kind'], data: Buffer): EvidenceRef {
  const extension = kind === 'png' ? 'png' : 'json';
  return { id, path: `evidence/${id}.${extension}`, bytes: data.length, kind };
}

/** A JSON evidence item, stored pretty-printed as the evidence store writes it. */
export function jsonEvidence(
  id: string,
  kind: 'measurements' | 'styles',
  label: string,
  value: unknown,
): StoredEvidence {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { item: { kind, label, ref: refOf(id, 'json', data) }, data };
}

/** A crop of `bytes` bytes, each byte the id's first character code (so two crops never share bytes). */
export function cropEvidence(id: string, label: string, bytes: number): StoredEvidence {
  const data = Buffer.alloc(bytes, id.charCodeAt(0));
  return { item: { kind: 'crop', label, ref: refOf(id, 'png', data) }, data };
}

/** Reads the bytes of the evidence given; any other ref is a test bug, so it rejects. */
export function readerOf(stored: readonly StoredEvidence[]): (ref: EvidenceRef) => Promise<Buffer> {
  const byId = new Map(stored.map(({ item, data }) => [item.ref.id, data]));
  return async (ref) => {
    const data = byId.get(ref.id);
    if (data === undefined) throw new Error(`no evidence ${ref.id} in this test`);
    return data;
  };
}

export interface FocusFindingOptions {
  readonly name?: string;
  readonly observed?: string;
  readonly evidence?: readonly StoredEvidence[];
  readonly createdAt?: string;
}

/** The bench's missing focus ring: the Save button on /settings shows nothing when focused. */
export function focusFinding(options: FocusFindingOptions = {}): StepFinding {
  return stepFinding({
    rule: FOCUS_VISIBLE,
    screen: { id: 'screen-settings', route: '/settings', url: SETTINGS_URL },
    target: {
      selector: SAVE_SELECTOR,
      role: 'button',
      name: options.name ?? 'Save',
      componentName: 'SaveButton',
      signature: 'button.btn.btn-primary',
      box: { x: 24, y: 480, width: 96, height: 36 },
    },
    trace: {
      route: '/settings',
      url: SETTINGS_URL,
      viewport: VIEWPORT,
      steps: [
        { kind: 'navigate', url: SETTINGS_URL },
        { kind: 'set-viewport', viewport: VIEWPORT },
        { kind: 'force-state', selector: SAVE_SELECTOR, state: 'focus' },
        { kind: 'measure', what: FOCUS_STYLES },
      ],
    },
    observed: options.observed ?? FOCUS_OBSERVED,
    evidence: (options.evidence ?? []).map(({ item }) => item),
    createdAt: options.createdAt ?? CREATED_AT,
  });
}

/** A console error seen on the dashboard, its message being `message`. */
export function consoleFinding(message: string): OccurrenceFinding {
  return occurrenceFinding({
    rule: CONSOLE_ERROR,
    key: message,
    occurrences: [
      {
        screenId: 'screen-home',
        route: '/',
        url: 'http://localhost:3123/',
        viewport: VIEWPORT,
        selector: null,
        measured: { message, type: 'error', location: 'http://localhost:3123/app.js:10:5', count: 1 },
      },
    ],
    observed: `logged "${message}"`,
    evidence: [],
    createdAt: CREATED_AT,
  });
}

export interface AttemptOptions {
  readonly reproduced?: boolean;
  readonly observed?: string | null;
  readonly skipped?: string | null;
  readonly durationMs?: number;
  readonly occurrence?: Attempt['occurrence'];
}

/** Three attempts alike: reproduced with the focus finding's `observed` unless told otherwise. */
export function attemptsOf(options: AttemptOptions = {}): Attempt[] {
  const reproduced = options.reproduced ?? true;
  return [1, 2, 3].map((index) => ({
    index,
    occurrence: options.occurrence ?? null,
    reproduced,
    observed: options.observed === undefined ? (reproduced ? FOCUS_OBSERVED : null) : options.observed,
    skipped: options.skipped ?? null,
    durationMs: options.durationMs ?? 420,
    evidence: [],
  }));
}

/** `text` with every wrapped page string taken out: what Lookover itself wrote. */
export function outsideWrappers(text: string): string {
  return text.replace(/<untrusted_page_content>[\s\S]*?<\/untrusted_page_content>/g, '');
}
