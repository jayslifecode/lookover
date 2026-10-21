import type {
  AppMap,
  ElementRef,
  ElementTarget,
  Finding,
  FindingsFile,
  FormInfo,
  Occurrence,
  OccurrenceFinding,
  Screen,
  Severity,
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

export function findingsFile(findings: Finding[], worthALook: Finding[] = []): FindingsFile {
  return { version: 1, runId: 'run-1', createdAt: '2026-10-22T00:00:00.000Z', findings, worthALook };
}
