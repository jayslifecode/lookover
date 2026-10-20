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

export interface Screen {
  id: string;
  url: string;
  route: string;
  title: string;
  viewport: Viewport;
  /** `null` when navigation failed, so there was nothing to capture. */
  screenshot: EvidenceRef | null;
  elements: ElementRef[];
  forms: FormInfo[];
  tokens: TokenSample[];
  links: string[];
  discoveredFrom: string | null;
  capturedAt: string;
}

export interface AppMap {
  version: 1;
  runId: string;
  createdAt: string;
  baseUrl: string;
  routes: RouteInfo[];
  screens: Screen[];
}
