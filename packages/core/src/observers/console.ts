import { ruleById } from '@jayslifecode/lookover-rules';
import type { ConsoleMessage } from 'playwright';
import type { InstrumentedPage } from '../browser/session.js';
import { occurrenceFinding } from '../findings/build.js';
import type { EvidenceItem, Finding } from '../findings/types.js';
import type { Screen } from '../map/types.js';
import type { RunContext } from '../run/run-context.js';
import { NavigationBuffer } from './buffer.js';
import { isIgnoredConsoleEntry } from './noise.js';
import type { Observer, ObserverResult } from './types.js';

/** Entries kept per screen; further ones are dropped and counted in the evidence. */
export const MAX_CONSOLE_ENTRIES = 500;
/** Characters kept of each message; a stack-laden log can be far longer than anyone reads. */
export const MAX_CONSOLE_TEXT_LENGTH = 2000;
const KEY_LENGTH = 200;
const MEASURED_MESSAGE_LENGTH = 300;
const OBSERVED_MESSAGE_LENGTH = 120;
const URL_PATTERN = /https?:\/\/\S+/g;
const NUMBER_PATTERN = /\d+/g;
const WHITESPACE_PATTERN = /\s+/g;

type EntryType = 'error' | 'warning' | 'pageerror';

/** One console error, console warning or uncaught exception, as the page reported it. */
interface ConsoleEntry {
  readonly at: string;
  readonly type: EntryType;
  /** For a page error, `name: message` without the stack. */
  readonly text: string;
  /** `url:line:col` of the call, when the browser says where it was. */
  readonly location: string | null;
}

/** The entries of one screen that say the same thing in the same way. */
interface ConsoleGroup {
  readonly type: EntryType;
  readonly key: string;
  readonly first: ConsoleEntry;
  readonly count: number;
}

const RULE_ID_OF: Readonly<Record<EntryType, string>> = {
  pageerror: 'observers.page-error',
  error: 'observers.console-error',
  warning: 'observers.console-warning',
};

/**
 * What identifies a message across screens and runs: URLs become `<url>` and numbers `#`, so
 * `Failed 3 rows at https://a.b/c?x=1` and `Failed 12 rows at https://a.b/d` are the same message.
 */
export function normaliseMessage(text: string): string {
  return collapseWhitespace(text.replace(URL_PATTERN, '<url>').replace(NUMBER_PATTERN, '#')).slice(
    0,
    KEY_LENGTH,
  );
}

/** Runs of whitespace (newlines included) become one space, and the ends are trimmed. */
function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE_PATTERN, ' ').trim();
}

/**
 * Watches the crawl page's console errors, console warnings and uncaught exceptions, and reports the
 * ones that came up while a screen loaded: errors and exceptions as candidates, warnings as worth a look.
 * Dev tooling chatter (see `noise.ts`) is dropped. The same message on one screen is one occurrence with
 * a count, and the same message on every screen is one finding (`key` is the normalised message).
 */
export class ConsoleObserver implements Observer {
  readonly name = 'console';

  private readonly buffer = new NavigationBuffer<ConsoleEntry>(MAX_CONSOLE_ENTRIES);

  constructor(private readonly ctx: RunContext) {}

  /**
   * The listeners only read the event and record it, so none of them can throw. What was logged before
   * a main-frame document navigation belongs to a page that is gone, so the buffer forgets it (see
   * `NavigationBuffer`).
   */
  attach({ page }: InstrumentedPage): void {
    this.buffer.attach(page);
    page.on('console', (message) => this.recordConsole(message));
    page.on('pageerror', (error) => this.record('pageerror', describePageError(error), null));
  }

  async collect(screen: Screen): Promise<ObserverResult> {
    const { entries, dropped } = this.buffer.drain();
    if (entries.length === 0) return { findings: [], worthALook: [], evidence: [] };
    const ref = await this.ctx.evidence.putJson(`console-${screen.id}`, {
      screenId: screen.id,
      url: screen.url,
      dropped,
      entries,
    });
    const evidence: EvidenceItem = { kind: 'console', label: `Console output on ${screen.route}`, ref };
    const groups = groupEntries(entries);
    return {
      findings: groups
        .filter(({ type }) => type !== 'warning')
        .map((group) => findingOf(group, screen, evidence)),
      worthALook: groups
        .filter(({ type }) => type === 'warning')
        .map((group) => findingOf(group, screen, evidence)),
      evidence: [evidence],
    };
  }

  private recordConsole(message: ConsoleMessage): void {
    const type = entryTypeOf(message.type());
    if (type === null) return;
    this.record(type, message.text(), locationOf(message.location()));
  }

  /** Dev noise is dropped here, so a chatty dev server cannot fill the buffer ahead of a real error. */
  private record(type: EntryType, text: string, location: string | null): void {
    const entry: ConsoleEntry = {
      at: new Date().toISOString(),
      type,
      text: text.slice(0, MAX_CONSOLE_TEXT_LENGTH),
      location,
    };
    if (isIgnoredConsoleEntry(entry)) return;
    this.buffer.record(entry);
  }
}

function entryTypeOf(consoleType: string): EntryType | null {
  if (consoleType === 'error') return 'error';
  if (consoleType === 'warning') return 'warning';
  return null;
}

/** Playwright counts lines and columns from 0; the location is for people, who count from 1. */
function locationOf({
  url,
  lineNumber,
  columnNumber,
}: ReturnType<ConsoleMessage['location']>): string | null {
  return url === '' ? null : `${url}:${lineNumber + 1}:${columnNumber + 1}`;
}

/** `name: message`, without the stack. Playwright gives a throw of a non-error (`throw 'boom'`) no name. */
function describePageError({ name, message }: Error): string {
  return name === '' ? message : `${name}: ${message}`;
}

/** One group per type and key, in the order each first appeared; the group keeps the first entry. */
function groupEntries(entries: readonly ConsoleEntry[]): ConsoleGroup[] {
  const groups = new Map<string, ConsoleGroup>();
  for (const entry of entries) {
    const key = normaliseMessage(entry.text);
    const id = `${entry.type}|${key}`;
    const known = groups.get(id);
    groups.set(
      id,
      known === undefined
        ? { type: entry.type, key, first: entry, count: 1 }
        : { ...known, count: known.count + 1 },
    );
  }
  return [...groups.values()];
}

function findingOf(
  { type, key, first, count }: ConsoleGroup,
  screen: Screen,
  evidence: EvidenceItem,
): Finding {
  const verb = type === 'pageerror' ? 'threw' : 'logged';
  return occurrenceFinding({
    rule: ruleById(RULE_ID_OF[type]),
    key,
    occurrences: [
      {
        screenId: screen.id,
        route: screen.route,
        url: screen.url,
        viewport: screen.viewport,
        selector: null,
        measured: {
          message: first.text.slice(0, MEASURED_MESSAGE_LENGTH),
          type,
          location: first.location,
          count,
        },
      },
    ],
    observed: `${verb} "${collapseWhitespace(first.text).slice(0, OBSERVED_MESSAGE_LENGTH)}"`,
    evidence: [evidence],
  });
}
