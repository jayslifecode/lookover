import type { EvidenceRef } from '@jayslifecode/lookover-core';
import type { FocusStop, GalleryEntry, GalleryState, StyleSnapshot } from '@jayslifecode/lookover-lenses';

/*
 * A state gallery file, read defensively. The lens wrote it from the page under review and the report's
 * server hands it back, so nothing in it is trusted: an entry or a focus stop that is not well formed is
 * left out (the rest still shows), a crop that is not an evidence ref is dropped, a state that is not a
 * style snapshot is dropped, and a text field of another type reads as none. What is kept has the lens's
 * types, narrowed to what the report shows.
 */

/** One control of the gallery, as the report shows it. */
export type GalleryControl = Pick<
  GalleryEntry,
  'role' | 'name' | 'componentName' | 'states' | 'crops' | 'skipped' | 'focusMarkVia'
>;

/** One stop of the focus order, as the report shows it. */
export type GalleryStop = Pick<FocusStop, 'index' | 'selector' | 'tag' | 'hidden'>;

export interface GalleryFile {
  readonly entries: readonly GalleryControl[];
  readonly focusOrder: readonly GalleryStop[];
}

const STATES: readonly GalleryState[] = ['rest', 'hover', 'focus', 'active'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Enough of an `EvidenceRef` for `evidenceUrl`, which checks the path itself. */
function isEvidenceRef(value: unknown): value is EvidenceRef {
  return isRecord(value) && typeof value.path === 'string';
}

/** The states of `value` whose entry passes `isKept`, by state. */
function statesOf<T>(value: Record<string, unknown>, isKept: (entry: unknown) => entry is T) {
  return Object.fromEntries(
    STATES.flatMap((state) => {
      const entry = value[state];
      return isKept(entry) ? [[state, entry]] : [];
    }),
  ) as Partial<Record<GalleryState, T>>;
}

function controlOf(value: unknown): GalleryControl | null {
  if (!isRecord(value) || typeof value.role !== 'string' || typeof value.name !== 'string') return null;
  if (!isRecord(value.states) || !isRecord(value.crops)) return null;
  const via = value.focusMarkVia;
  return {
    role: value.role,
    name: value.name,
    componentName: textOrNull(value.componentName),
    states: statesOf(value.states, (entry): entry is StyleSnapshot => isRecord(entry)),
    crops: statesOf(value.crops, isEvidenceRef),
    skipped: textOrNull(value.skipped),
    focusMarkVia: via === 'forced' || via === 'real' ? via : null,
  };
}

function stopOf(value: unknown): GalleryStop | null {
  if (!isRecord(value) || !Number.isInteger(value.index) || typeof value.tag !== 'string') return null;
  return {
    index: value.index as number,
    tag: value.tag,
    selector: textOrNull(value.selector),
    hidden: textOrNull(value.hidden),
  };
}

function kept<T>(values: readonly unknown[], read: (value: unknown) => T | null): T[] {
  return values.flatMap((value) => {
    const item = read(value);
    return item === null ? [] : [item];
  });
}

/** The gallery in `value`; `null` when it is not a gallery file at all. */
export function parseGallery(value: unknown): GalleryFile | null {
  if (!isRecord(value) || !Array.isArray(value.entries) || !Array.isArray(value.focusOrder)) return null;
  return { entries: kept(value.entries, controlOf), focusOrder: kept(value.focusOrder, stopOf) };
}
