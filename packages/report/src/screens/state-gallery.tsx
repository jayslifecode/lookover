import type { EvidenceRef } from '@jayslifecode/lookover-core';
import type { GalleryState, StyleSnapshot } from '@jayslifecode/lookover-lenses';
import { useEffect, useId, useRef, useState } from 'react';
import { evidenceUrl, fetchJson } from '@/data/api';
import { type GalleryControl, type GalleryFile, type GalleryStop, parseGallery } from './gallery-file';

/*
 * The screen's state gallery: the interaction lens's `gallery-<screenId>` evidence, which it names on
 * the screen's `screen.inspected`. One row per control the lens put in states: its role, name and
 * component, its crops at rest, on hover, with focus and when pressed, why it was not put in every state,
 * and whether its focus mark only showed with real focus. A control without crops shows what each state
 * changed in its styles instead. Below, the screen's focus order, as a Tab walk reached it.
 *
 * Each gallery is fetched once, and kept while the view is mounted, so coming back to a screen asks for
 * nothing. The file comes from the page under review, so it is read defensively (gallery-file.ts) and
 * every value is shown as text. A long gallery shows its first controls and focus stops, with a
 * button for the rest.
 */

export interface StateGalleryProps {
  /** The screen's gallery; `null` when no lens wrote one, or the screen is not inspected yet. */
  readonly gallery: EvidenceRef | null;
  /** The lenses are still on the screen, so its gallery may yet come. */
  readonly isInspecting?: boolean;
}

type GalleryLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly gallery: GalleryFile }
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
/** A long gallery shows this many controls, and its focus order this many stops, until asked for all. */
export const GALLERY_PREVIEW_ROWS = 8;
export const FOCUS_ORDER_PREVIEW = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadGallery(url: string): Promise<GalleryFile> {
  const gallery = parseGallery(await fetchJson(url));
  if (gallery === null) throw new Error('the file is not a state gallery');
  return gallery;
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

function StateChanges({ entry }: { readonly entry: GalleryControl }) {
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

function Crops({ entry }: { readonly entry: GalleryControl }) {
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

function EntryRow({ entry }: { readonly entry: GalleryControl }) {
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

/** The first `preview` items until the reader asks for all of them. */
function useCollapsible<T>(items: readonly T[], preview: number) {
  const [isExpanded, setExpanded] = useState(false);
  return {
    shown: isExpanded ? items : items.slice(0, preview),
    isExpanded,
    isLong: items.length > preview,
    toggle: () => setExpanded((expanded) => !expanded),
  };
}

function ShowAll({
  count,
  noun,
  isExpanded,
  controls,
  onToggle,
}: {
  readonly count: number;
  readonly noun: string;
  readonly isExpanded: boolean;
  /** The id of the list it shows more of. */
  readonly controls: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      aria-controls={controls}
      onClick={onToggle}
      className="mt-2 inline-flex min-h-8 cursor-pointer items-center rounded-md border border-line-strong bg-bg-2 px-3 font-semibold text-[12.5px] text-ink hover:bg-bg-0"
    >
      {isExpanded ? `Show fewer ${noun}` : `Show all ${count} ${noun}`}
    </button>
  );
}

function FocusOrder({ stops }: { readonly stops: readonly GalleryStop[] }) {
  const titleId = useId();
  const listId = useId();
  const { shown, isExpanded, isLong, toggle } = useCollapsible(stops, FOCUS_ORDER_PREVIEW);
  return (
    <div className="mt-4 border-line border-t pt-3">
      <h3 id={titleId} className="font-semibold text-[13.5px]">
        Focus order
      </h3>
      {stops.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-2">Tab reached nothing on this screen.</p>
      ) : (
        <ol
          id={listId}
          aria-labelledby={titleId}
          className="mt-2 grid list-decimal gap-1 pl-8 text-[12px] marker:text-ink-2"
        >
          {shown.map((stop) => (
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
      {isLong ? (
        <ShowAll
          count={stops.length}
          noun="stops"
          isExpanded={isExpanded}
          controls={listId}
          onToggle={toggle}
        />
      ) : null}
    </div>
  );
}

function Controls({ entries }: { readonly entries: readonly GalleryControl[] }) {
  const listId = useId();
  const { shown, isExpanded, isLong, toggle } = useCollapsible(entries, GALLERY_PREVIEW_ROWS);
  if (entries.length === 0) {
    return <p className="mt-1 text-ink-2">No control on this screen was put in states.</p>;
  }
  return (
    <>
      <ul id={listId} aria-label="Controls in each state" className="mt-1">
        {shown.map((entry, index) => (
          // A selector can repeat in a gallery; its place in the list cannot.
          // biome-ignore lint/suspicious/noArrayIndexKey: the gallery is never reordered
          <EntryRow key={index} entry={entry} />
        ))}
      </ul>
      {isLong ? (
        <ShowAll
          count={entries.length}
          noun="controls"
          isExpanded={isExpanded}
          controls={listId}
          onToggle={toggle}
        />
      ) : null}
    </>
  );
}

function GalleryBody({
  load,
  isInspecting,
}: {
  readonly load: GalleryLoad | null;
  readonly isInspecting: boolean;
}) {
  if (load === null && isInspecting) {
    return <p className="mt-1 text-ink-2">The gallery comes once this screen is inspected.</p>;
  }
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
  return (
    <>
      <Controls entries={load.gallery.entries} />
      <FocusOrder stops={load.gallery.focusOrder} />
    </>
  );
}

export function StateGallery({ gallery, isInspecting = false }: StateGalleryProps) {
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
      {/* Each screen's gallery starts collapsed. */}
      <GalleryBody key={url ?? 'none'} load={shown} isInspecting={isInspecting} />
    </section>
  );
}
