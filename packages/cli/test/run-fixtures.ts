import type {
  AppMap,
  Attempt,
  ElementRef,
  ElementTarget,
  Environment,
  Finding,
  FindingsFile,
  FormInfo,
  JudgeTotals,
  Occurrence,
  OccurrenceFinding,
  Screen,
  Severity,
  SkipTally,
  StepFinding,
  Viewport,
} from '@jayslifecode/lookover-core';

export function element(name: string): ElementRef {
  return {
    selector: `#${name}`,
    role: 'button',
    name,
    tag: 'button',
    box: { x: 0, y: 0, width: 10, height: 10 },
    disabled: false,
    focusable: true,
  };
}

export function form(selector: string): FormInfo {
  return { selector, action: null, method: 'get', fields: [], submit: null };
}

export function screen(overrides: Partial<Screen> = {}): Screen {
  return {
    id: 'abc',
    url: 'http://localhost:3000/',
    route: '/',
    title: 'Home',
    status: 'captured',
    error: null,
    viewport: { name: 'desktop', width: 1440, height: 900 },
    screenshot: null,
    elements: [],
    forms: [],
    tokens: [],
    links: [],
    redirectedFrom: null,
    discoveredFrom: null,
    capturedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

export function appMap(screens: Screen[]): AppMap {
  return {
    version: 1,
    runId: 'run-1',
    createdAt: '2026-10-21T00:00:00.000Z',
    baseUrl: 'http://localhost:3000',
    routes: [],
    screens,
  };
}

const DESKTOP: Viewport = { name: 'desktop', width: 1440, height: 900 };

export interface StepOptions {
  readonly ruleId: string;
  readonly severity?: Severity;
  readonly route?: string;
  readonly selector?: string;
  readonly role?: string;
  readonly name?: string;
  /** `null` is a step finding with no element to point at. */
  readonly target?: ElementTarget | null;
}

function elementTarget(selector: string, role: string, name: string): ElementTarget {
  return {
    selector,
    role,
    name,
    componentName: null,
    signature: null,
    box: { x: 0, y: 0, width: 10, height: 10 },
  };
}

export function stepCandidate(options: StepOptions): StepFinding {
  const { ruleId, severity = 'high', route = '/', selector = '#a', role = 'button', name = 'Save' } = options;
  return {
    shape: 'step',
    id: `${ruleId}|${route}|${selector}`,
    key: `${route}|${selector}`,
    source: 'interaction',
    rule: { id: ruleId, source: 'catalogue' },
    severity,
    status: 'candidate',
    judgement: null,
    title: `Title of ${ruleId}`,
    expected: 'expected',
    observed: 'observed',
    whyItMatters: 'why',
    evidence: [],
    fixPrompt: `fix ${route}`,
    createdAt: '2026-10-22T00:00:00.000Z',
    screenId: `screen-${route}`,
    target: options.target === undefined ? elementTarget(selector, role, name) : options.target,
    trace: { route, url: `http://localhost:3000${route}`, viewport: DESKTOP, steps: [] },
  };
}

function occurrence(screenId: string, selector: string | null = null): Occurrence {
  return {
    screenId,
    route: `/${screenId}`,
    url: `http://localhost:3000/${screenId}`,
    viewport: DESKTOP,
    selector,
    measured: {},
  };
}

export function occurrenceCandidate(
  ruleId: string,
  screenIds: readonly string[],
  severity: Severity = 'medium',
): Finding {
  const finding: OccurrenceFinding = {
    shape: 'occurrence',
    id: `${ruleId}|${screenIds.join(',')}`,
    key: screenIds.join(','),
    source: 'observers',
    rule: { id: ruleId, source: 'catalogue' },
    severity,
    status: 'candidate',
    judgement: null,
    title: `Title of ${ruleId}`,
    expected: 'expected',
    observed: 'observed',
    whyItMatters: 'why',
    evidence: [],
    fixPrompt: 'fix',
    createdAt: '2026-10-22T00:00:00.000Z',
    occurrences: screenIds.map((screenId) => occurrence(screenId)),
  };
  return finding;
}

export function findingsFile(
  findings: Finding[],
  worthALook: Finding[] = [],
  skipped?: SkipTally[],
): FindingsFile {
  return {
    version: 2,
    runId: 'run-1',
    createdAt: '2026-10-22T00:00:00.000Z',
    findings,
    worthALook,
    ...(skipped === undefined ? {} : { skipped }),
    rejected: [],
    intended: [],
    judge: null,
    environment: null,
  };
}

const ATTEMPTS = 3;
const JUDGED_AT = '2026-10-22T00:01:00.000Z';
export const ENVIRONMENT: Environment = {
  browser: 'chromium 140.0.7339.16',
  os: 'darwin 25.0.0 arm64',
  node: 'v24.10.0',
  lookover: '0.0.0',
  viewport: DESKTOP,
};

/** What the judge cost in a run without `ANTHROPIC_API_KEY`: nothing, the harness decided alone. */
export const HARNESS_ONLY: JudgeTotals = {
  model: null,
  calls: 0,
  cacheHits: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  estimatedUsd: null,
  unavailable: 'no-api-key',
};

export interface JudgedOptions {
  readonly status?: 'confirmed' | 'rejected';
  /** How many of the three attempts reproduced the finding (each occurrence's, for an occurrence finding). */
  readonly reproduced?: number;
}

/** Three attempts at one target, the first `reproduced` of them seeing the finding again. */
function attemptsAt(occurrence: Attempt['occurrence'], reproduced: number): Attempt[] {
  return Array.from({ length: ATTEMPTS }, (_, index) => ({
    index: index + 1,
    occurrence,
    reproduced: index < reproduced,
    observed: index < reproduced ? 'observed' : null,
    skipped: null,
    durationMs: 100,
    evidence: [],
  }));
}

/** `finding` as the harness judged it: three attempts at each of its targets, and the status they give. */
export function judged<T extends Finding>(finding: T, options: JudgedOptions = {}): T {
  const { status = 'confirmed', reproduced = ATTEMPTS } = options;
  const targets: Attempt['occurrence'][] =
    finding.shape === 'step'
      ? [null]
      : finding.occurrences.map(({ screenId, selector, viewport }) => ({
          screenId,
          selector,
          viewport: viewport.name,
        }));
  return {
    ...finding,
    status,
    judgement: {
      reproduced: finding.shape === 'step' ? reproduced : reproduced === ATTEMPTS ? targets.length : 0,
      of: finding.shape === 'step' ? ATTEMPTS : targets.length,
      attempts: targets.flatMap((occurrence) => attemptsAt(occurrence, reproduced)),
      decidedBy: 'harness',
      attribution: status === 'confirmed' ? 'product-defect' : 'timing',
      oracle: null,
      note: null,
      model: null,
      usage: null,
      estimatedUsd: null,
      cached: false,
      droppedOccurrences: [],
      environment: ENVIRONMENT,
      judgedAt: JUDGED_AT,
    },
  };
}

/** The findings file of a judged run: `findings` holds what was confirmed; harness only unless `judge` says. */
export function judgedFile(overrides: Partial<FindingsFile> = {}): FindingsFile {
  return { ...findingsFile([]), judge: HARNESS_ONLY, environment: ENVIRONMENT, ...overrides };
}
