import type { EvidenceRef } from '@jayslifecode/lookover-core';
import type {
  FocusStop,
  GalleryEntry,
  GalleryState,
  StateGallery as StateGalleryFile,
  StyleSnapshot,
} from '@jayslifecode/lookover-lenses';
import { useEffect, useId, useRef, useState } from 'react';
import { evidenceUrl, fetchJson } from '@/data/api';

/*
 * The screen's state gallery: the interaction lens's `gallery-<screenId>` evidence, which it names on
 * the screen's `screen.inspected`. One row per control the lens put in states: its role, name and
 * component, its crops at rest, on hover, with focus and when pressed, why it was not put in every state,
 * and whether its focus mark only showed with real focus. A control without crops shows what each state
 * changed in its styles instead. Below, the screen's focus order, as a Tab walk reached it.
 *
 * Each gallery is fetched once, and kept while the view is mounted, so coming back to a screen asks for
 * nothing. The file comes from the page under review, so it is checked for its shape before it is used,
 * and every value is shown as text.
 */

export interface StateGalleryProps {
  /** The screen's gallery; `null` when no lens wrote one. */
  readonly gallery: EvidenceRef | null;
}

type GalleryLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly gallery: StateGalleryFile }
  | { readonly status: 'failed'; readonly message: string };

const LOADING: GalleryLoad = { status: 'loading' };
const STATES: readonly GalleryState[] = ['rest', 'hover', 'focus', 'active'];
const CHANGED_STATES: readonly GalleryState[] = ['hover', 'focus', 'active'];
const STATE_LABEL: Readonly<Record<GalleryState, string>> = {
  rest: 'Rest',
  hover: 'Hover',
  focus: 'Focus',
  active: 'Active',
};
/** How the alt text of a crop names its state. */
const STATE_PHRASE: Readonly<Record<GalleryState, string>> = {
  rest: 'at rest',
  hover: 'on hover',
  focus: 'with focus',
  active: 'when pressed',
};
type SnapshotPart = keyof StyleSnapshot;
const SNAPSHOT_PARTS: readonly SnapshotPart[] = ['self', 'before', 'after'];
const PART_PREFIX: Readonly<Record<SnapshotPart, string>> = {
  self: '',
  before: '::before ',
  after: '::after ',
};
/** Per state, at most this many changed properties are listed; the rest are counted. */
const MAX_CHANGES_SHOWN = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.role === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.states) &&
    isRecord(value.crops)
  );
}

function isStop(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.index) && typeof value.tag === 'string';
}

function isGalleryFile(value: unknown): value is StateGalleryFile {
  return (
    isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(isEntry) &&
    Array.isArray(value.focusOrder) &&
    value.focusOrder.every(isStop)
  );
}

async function loadGallery(url: string): Promise<StateGalleryFile> {
  const body = await fetchJson(url);
  if (!isGalleryFile(body)) throw new Error('the file is not a state gallery');
  return body;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The gallery at `url`, fetched the first time it is asked for; `null` for no gallery. */
function useGallery(url: string | null): GalleryLoad | null {
  const [loads, setLoads] = useState<ReadonlyMap<string, GalleryLoad>>(() => new Map());
  const requested = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (url === null || requested.current.has(url)) return;
    requested.current = new Set([...requested.current, url]);
    const settle = (load: GalleryLoad) => setLoads((known) => new Map(known).set(url, load));
    loadGallery(url).then(
      (gallery) => settle({ status: 'loaded', gallery }),
      (error: unknown) => settle({ status: 'failed', message: messageOf(error) }),
    );
  }, [url]);
  if (url === null) return null;
  return loads.get(url) ?? LOADING;
}

function valuesOf(snapshot: StyleSnapshot, part: SnapshotPart): Readonly<Record<string, unknown>> {
  const values: unknown = snapshot[part];
  return isRecord(values) ? values : {};
}

/** What `state` changed from rest, as `property value` (pseudo-elements prefixed). */
function changesFrom(rest: StyleSnapshot, state: StyleSnapshot): string[] {
  return SNAPSHOT_PARTS.flatMap((part) => {
    const before = valuesOf(rest, part);
    return Object.entries(valuesOf(state, part))
      .filter(([property, value]) => before[property] !== value)
      .map(([property, value]) => `${PART_PREFIX[part]}${property} ${String(value)}`);
  });
}

function changeSummary(changes: readonly string[]): string {
  if (changes.length === 0) return 'no change';
  const shown = changes.slice(0, MAX_CHANGES_SHOWN).join(', ');
  const more = changes.length - MAX_CHANGES_SHOWN;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

function StateChanges({ entry }: { readonly entry: GalleryEntry }) {
  const rest = entry.states.rest;
  if (rest === undefined) return <p className="text-[12.5px] text-ink-2">No style snapshot was taken.</p>;
  const changed = CHANGED_STATES.flatMap((state) => {
    const snapshot = entry.states[state];
    return snapshot === undefined ? [] : [{ state, summary: changeSummary(changesFrom(rest, snapshot)) }];
  });
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11.5px]">
      {changed.map(({ state, summary }) => (
        <div key={state} className="contents">
          <dt className="text-ink-2">{state}</dt>
          <dd className="m-0 truncate text-ink" title={summary}>
            {summary}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Crops({ entry }: { readonly entry: GalleryEntry }) {
  const subject = entry.name === '' ? entry.role : `${entry.name} (${entry.role})`;
  const crops = STATES.flatMap((state) => {
    const ref = entry.crops[state];
    const url = ref === undefined ? null : evidenceUrl(ref);
    return url === null ? [] : [{ state, url }];
  });
  if (crops.length === 0) return <StateChanges entry={entry} />;
  return (
    <ul aria-label={`${subject} in each state`} className="flex flex-wrap gap-3">
      {crops.map(({ state, url }) => (
        <li key={state}>
          <figure className="m-0 grid gap-1">
            <img
              src={url}
              alt={`${subject} ${STATE_PHRASE[state]}`}
              loading="lazy"
              decoding="async"
              className="block h-auto max-h-20 w-auto max-w-[200px] rounded-sm border border-line bg-white"
            />
            <figcaption className="text-[11.5px] text-ink-2">{STATE_LABEL[state]}</figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}

function EntryRow({ entry }: { readonly entry: GalleryEntry }) {
  return (
    <li className="grid gap-2 border-line border-t py-3 first:border-t-0">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[12px] text-ink-2">{entry.role}</span>
        <span className="font-semibold text-ink">{entry.name === '' ? '(no name)' : entry.name}</span>
        {entry.componentName === null ? null : (
          <code className="font-mono text-[12px] text-ink-2">{entry.componentName}</code>
        )}
        {entry.focusMarkVia === 'real' ? (
          <span className="text-[12px] text-ink-2">mark found with real focus</span>
        ) : null}
      </p>
      <Crops entry={entry} />
      {entry.skipped === null ? null : (
        <p className="text-[12.5px] text-ink-2">Not put in every state: {entry.skipped}</p>
      )}
    </li>
  );
}

function FocusOrder({ stops }: { readonly stops: readonly FocusStop[] }) {
  const titleId = useId();
  return (
    <div className="mt-4 border-line border-t pt-3">
      <h3 id={titleId} className="font-semibold text-[13.5px]">
        Focus order
      </h3>
      {stops.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-2">Tab reached nothing on this screen.</p>
      ) : (
        <ol
          aria-labelledby={titleId}
          className="mt-2 grid list-decimal gap-1 pl-8 text-[12px] marker:text-ink-2"
        >
          {stops.map((stop) => (
            <li key={stop.index} value={stop.index}>
              <code className="font-mono text-ink">{stop.tag}</code>{' '}
              <code className="break-all font-mono text-ink-2">{stop.selector ?? 'not found again'}</code>
              {stop.hidden === null ? null : (
                <span className="ml-2 font-semibold text-ink">hidden: {stop.hidden}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function GalleryBody({ load }: { readonly load: GalleryLoad | null }) {
  if (load === null) return <p className="mt-1 text-ink-2">No gallery for this screen</p>;
  if (load.status === 'loading') {
    return (
      <p role="status" className="mt-1 text-ink-2">
        Loading the state gallery…
      </p>
    );
  }
  if (load.status === 'failed') {
    return <p className="mt-1 text-ink-2">The state gallery could not be loaded: {load.message}</p>;
  }
  const { entries, focusOrder } = load.gallery;
  return (
    <>
      {entries.length === 0 ? (
        <p className="mt-1 text-ink-2">No control on this screen was put in states.</p>
      ) : (
        <ul aria-label="Controls in each state" className="mt-1">
          {entries.map((entry, index) => (
            // A selector can repeat in a gallery; its place in the list cannot.
            // biome-ignore lint/suspicious/noArrayIndexKey: the gallery is never reordered
            <EntryRow key={index} entry={entry} />
          ))}
        </ul>
      )}
      <FocusOrder stops={focusOrder} />
    </>
  );
}

export function StateGallery({ gallery }: StateGalleryProps) {
  const titleId = useId();
  const url = gallery === null ? null : evidenceUrl(gallery);
  const load = useGallery(url);
  const shown: GalleryLoad | null =
    gallery !== null && url === null
      ? { status: 'failed', message: "its file is outside the run's evidence" }
      : load;
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-line bg-bg-1 p-4">
      <h2 id={titleId} className="font-semibold text-[15px]">
        State gallery
      </h2>
      <GalleryBody load={shown} />
    </section>
  );
}
