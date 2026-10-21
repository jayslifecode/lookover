import type { EvidenceRef } from '../evidence/store.js';

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `pattern` keeps Next syntax (`/organisations/[id]`, `/docs/[...slug]`). */
export interface RouteInfo {
  pattern: string;
  source: 'filesystem' | 'link';
  file?: string;
}

export interface ElementRef {
  /** Finds exactly this element in the live page, and is the same after redaction (`stableSelector`). */
  selector: string;
  role: string;
  name: string;
  tag: string;
  box: Box;
  /** Absent for refs built in-page, where no CDP node id exists. */
  backendNodeId?: number;
  disabled: boolean;
  focusable: boolean;
}

export interface FieldInfo {
  selector: string;
  name: string | null;
  label: string | null;
  labelSource: 'label' | 'aria-label' | 'aria-labelledby' | 'placeholder' | null;
  type: string;
  required: boolean;
  pattern: string | null;
  minLength: number | null;
  maxLength: number | null;
  min: string | null;
  max: string | null;
  inputMode: string | null;
}

export interface FormInfo {
  selector: string;
  action: string | null;
  method: string;
  fields: FieldInfo[];
  submit: ElementRef | null;
}

export type TokenProperty =
  | 'color'
  | 'background-color'
  | 'font-size'
  | 'font-family'
  | 'border-radius'
  | 'padding'
  | 'margin';

export interface TokenSample {
  property: TokenProperty;
  value: string;
  count: number;
}

/** `navigation-failed`: the page could not be loaded or read, so nothing in it was captured. */
export type ScreenStatus = 'captured' | 'navigation-failed';

export interface Screen {
  id: string;
  /** Where the page landed: the requested URL, or the one a redirect inside the app led to. */
  url: string;
  /** The route of `url`, matched on its path below the base path. */
  route: string;
  /** The page's title; `(navigation failed: <error>)` for a failed navigation, for people to read. */
  title: string;
  status: ScreenStatus;
  /** Why the navigation failed (the first line of the browser's message); `null` when captured. */
  error: string | null;
  viewport: Viewport;
  /** `null` when navigation failed, so there was nothing to capture. */
  screenshot: EvidenceRef | null;
  elements: ElementRef[];
  forms: FormInfo[];
  tokens: TokenSample[];
  links: string[];
  /** The URL that was requested when the page landed somewhere else in the app; `null` otherwise. */
  redirectedFrom: string | null;
  discoveredFrom: string | null;
  capturedAt: string;
}

/** True for a screen whose navigation failed: it is in the map (a dead link) but holds nothing. */
export function isFailedScreen(screen: Pick<Screen, 'status'>): boolean {
  return screen.status === 'navigation-failed';
}

export interface AppMap {
  version: 1;
  runId: string;
  createdAt: string;
  baseUrl: string;
  routes: RouteInfo[];
  screens: Screen[];
}
