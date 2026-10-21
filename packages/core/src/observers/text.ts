import { ruleById } from '@jayslifecode/lookover-rules';
import type { Page } from 'playwright';
import type { InstrumentedPage } from '../browser/session.js';
import { occurrenceFinding } from '../findings/build.js';
import type { EvidenceItem, Finding } from '../findings/types.js';
import { BUILD_SELECTOR_SOURCE, type SelectorCandidate, stableSelector } from '../map/selectors.js';
import type { Screen } from '../map/types.js';
import type { RunContext } from '../run/run-context.js';
import { redact } from '../util/redact.js';
import type { Observer, ObserverResult } from './types.js';

/** Hits reported per screen; further ones are counted in the evidence. */
export const MAX_TEXT_HITS = 50;
/** Characters kept of each hit's text in the evidence. */
export const MAX_HIT_TEXT_LENGTH = 500;
/** Characters of a hit's text that go into its key, its occurrence and its sentence. */
const SUMMARY_TEXT_LENGTH = 120;
const WHITESPACE_PATTERN = /\s+/g;

type TextKind = 'raw-value' | 'unresolved-placeholder' | 'raw-i18n-key';

const RULE_ID_OF: Readonly<Record<TextKind, string>> = {
  'raw-value': 'observers.raw-value',
  'unresolved-placeholder': 'observers.unresolved-placeholder',
  'raw-i18n-key': 'observers.raw-i18n-key',
};

/** What the page reports for one leaked text: the trimmed text node, and the selectors of its parent. */
interface InPageHit {
  kind: TextKind;
  text: string;
  /** `null` when the selectors do not resolve to the parent element (see `scanText`). */
  selector: SelectorCandidate | null;
}

interface InPageScan {
  hits: InPageHit[];
  /** How many hits came up after the `limit`. */
  dropped: number;
}

/** A hit as it is stored: its text redacted and cut, its selector the one redaction leaves alone. */
interface TextHit {
  readonly kind: TextKind;
  readonly text: string;
  readonly selector: string | null;
}

/**
 * Runs in the page, so it must stay self-contained: no imports and no references to module scope, which
 * is why its constants and helpers are inside it. `SCAN_TEXT_SOURCE` passes in `BUILD_SELECTOR_SOURCE` as
 * `buildSelector` and `MAX_TEXT_HITS` as `limit`.
 *
 * Walks the text nodes of `<body>` in document order and reports the ones that look like a leak
 * (see `kindsOf`), at most `limit` of them; the rest are only counted. Text inside code on purpose
 * (`code`, `pre`, `kbd`, `samp`, `textarea`, `option`), in markup that is not content (`script`,
 * `style`, `noscript`, `template`) or that nobody can see (`checkVisibility`: no `display`, not
 * `visibility: hidden`, not `opacity: 0`) is skipped. A hit's selectors are those of the text node's
 * parent element, and `null` when either does not find that element in the document again: both can
 * end up stored (see `stableSelector`). Text is cut to 10000 characters on the way out; the caller
 * redacts it and cuts it far shorter, so no secret can straddle the cut that is kept.
 */
function scanText(buildSelector: (el: Element) => SelectorCandidate, limit: number): InPageScan {
  const SKIPPED_ELEMENTS = 'script, style, noscript, template, code, pre, kbd, samp, textarea, option';
  const RAW_VALUES = new Set(['undefined', 'null', 'NaN', '[object Object]', 'Infinity', '-Infinity']);
  const RAW_VALUE_ANYWHERE = /\[object Object\]|\bNaN\b/;
  const UNDEFINED_AT_END = /\bundefined$/;
  const PLACEHOLDERS = [/\{\{\s*[\w.]+\s*\}\}/, /(?<![\w$])\{[A-Za-z_][\w.]*\}/];
  // Every segment starts with a letter, so no segment is digits only (`v1.2.3` is no key).
  const I18N_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/;
  const KNOWN_SUFFIXES = new Set([
    'com',
    'org',
    'net',
    'io',
    'dev',
    'app',
    'co',
    'uk',
    'de',
    'kr',
    'mn',
    'jp',
    'js',
    'ts',
    'jsx',
    'tsx',
    'json',
    'md',
    'html',
    'css',
    'png',
    'jpg',
    'jpeg',
    'svg',
    'gif',
  ]);
  const MAX_TRANSFERRED_LENGTH = 10_000;

  const isRawValue = (text: string): boolean =>
    RAW_VALUES.has(text) || RAW_VALUE_ANYWHERE.test(text) || UNDEFINED_AT_END.test(text);
  const isI18nKey = (text: string): boolean =>
    I18N_KEY.test(text) && !KNOWN_SUFFIXES.has(text.slice(text.lastIndexOf('.') + 1));
  /** What the text leaks, in the order of `TextKind`; a text can be more than one. */
  const kindsOf = (text: string): TextKind[] => {
    const kinds: TextKind[] = [];
    if (isRawValue(text)) kinds.push('raw-value');
    if (PLACEHOLDERS.some((pattern) => pattern.test(text))) kinds.push('unresolved-placeholder');
    if (isI18nKey(text)) kinds.push('raw-i18n-key');
    return kinds;
  };
  const isShown = (el: Element): boolean =>
    el.closest(SKIPPED_ELEMENTS) === null &&
    el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const selectorOf = (el: Element): SelectorCandidate | null => {
    const candidate = buildSelector(el);
    const resolvesToEl = (selector: string): boolean => document.querySelector(selector) === el;
    return resolvesToEl(candidate.selector) && resolvesToEl(candidate.path) ? candidate : null;
  };

  const hits: InPageHit[] = [];
  let dropped = 0;
  if (document.body === null) return { hits, dropped };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = (node.nodeValue ?? '').trim();
    // The cheap test first: only a text that looks like a leak is worth asking the page about.
    const kinds = text === '' ? [] : kindsOf(text);
    if (parent === null || kinds.length === 0 || !isShown(parent)) continue;
    for (const kind of kinds) {
      if (hits.length >= limit) {
        dropped += 1;
        continue;
      }
      hits.push({ kind, text: text.slice(0, MAX_TRANSFERRED_LENGTH), selector: selectorOf(parent) });
    }
  }
  return { hits, dropped };
}

/** An expression for `page.evaluate`, which runs a string rather than calls it: the scan of this page. */
const SCAN_TEXT_SOURCE = `(${scanText.toString()})(${BUILD_SELECTOR_SOURCE}, ${MAX_TEXT_HITS})`;

/**
 * Looks at what the screen shows and reports text that should never reach a visitor: a raw value
 * (`undefined`, `NaN`, `[object Object]`), a template placeholder that was not filled in (`{{name}}`,
 * `{count}`) and a translation key (`settings.timezone.label`). The same text on one screen is one
 * occurrence, at the first element showing it, and the same text on every screen is one finding
 * (`key` is the kind and the first 120 characters of the text).
 *
 * It has nothing to listen for: the page is read when the screen is collected, so `attach` only keeps it.
 */
export class TextObserver implements Observer {
  readonly name = 'text';

  private page: Page | null = null;

  constructor(private readonly ctx: RunContext) {}

  attach({ page }: InstrumentedPage): void {
    this.page = page;
  }

  async collect(screen: Screen): Promise<ObserverResult> {
    const scan = await this.attachedPage().evaluate<InPageScan>(SCAN_TEXT_SOURCE);
    const hits = scan.hits.map(storedHit);
    if (hits.length === 0) return { findings: [], worthALook: [], evidence: [] };
    const ref = await this.ctx.evidence.putJson(`text-${screen.id}`, {
      screenId: screen.id,
      url: screen.url,
      dropped: scan.dropped,
      hits,
    });
    const evidence: EvidenceItem = { kind: 'text', label: `Rendered text on ${screen.route}`, ref };
    return {
      findings: groupHits(hits).map((hit) => findingOf(hit, screen, evidence)),
      worthALook: [],
      evidence: [evidence],
    };
  }

  private attachedPage(): Page {
    if (this.page === null) {
      throw new Error('TextObserver.collect was called before attach: there is no page to read');
    }
    return this.page;
  }
}

/** The text is redacted before it is cut, because a secret that straddles the cut would no longer look like one. */
function storedHit({ kind, text, selector }: InPageHit): TextHit {
  return {
    kind,
    text: redact(text).slice(0, MAX_HIT_TEXT_LENGTH),
    selector: selector === null ? null : stableSelector(selector),
  };
}

function keyOf({ kind, text }: TextHit): string {
  return `${kind}|${text.slice(0, SUMMARY_TEXT_LENGTH)}`;
}

/** The first hit of each key, in document order. */
function groupHits(hits: readonly TextHit[]): TextHit[] {
  const groups = new Map<string, TextHit>();
  for (const hit of hits) {
    const key = keyOf(hit);
    if (!groups.has(key)) groups.set(key, hit);
  }
  return [...groups.values()];
}

function findingOf(hit: TextHit, screen: Screen, evidence: EvidenceItem): Finding {
  const shown = hit.text.slice(0, SUMMARY_TEXT_LENGTH);
  return occurrenceFinding({
    rule: ruleById(RULE_ID_OF[hit.kind]),
    key: keyOf(hit),
    occurrences: [
      {
        screenId: screen.id,
        route: screen.route,
        url: screen.url,
        viewport: screen.viewport,
        selector: hit.selector,
        measured: { text: shown, kind: hit.kind },
      },
    ],
    observed: `shows "${shown.replace(WHITESPACE_PATTERN, ' ').trim()}"`,
    evidence: [evidence],
  });
}
