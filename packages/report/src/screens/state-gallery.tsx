import type { EvidenceRef } from '@jayslifecode/lookover-core';
import { memo, useEffect, useId, useRef, useState } from 'react';
import { evidenceUrl, fetchJson } from '@/data/api';
import { GalleryBody, type GalleryLoad } from './gallery-body';
import { type GalleryFile, parseGallery } from './gallery-file';

/*
 * The screen's state gallery: the interaction lens's `gallery-<screenId>` evidence, which it names on
 * the screen's `screen.inspected`, shown by gallery-body.tsx: a row per control in each state, then the
 * screen's focus order.
 *
 * Each gallery is fetched once, and kept while the view is mounted, so coming back to a screen asks for
 * nothing. The file comes from the page under review, so it is read defensively (gallery-file.ts). The
 * gallery renders again only for another gallery (or when its own fetch settles): choosing a finding, or
 * an event of the run, leaves it as it is.
 */

export interface StateGalleryProps {
  /** The screen's gallery; `null` when no lens wrote one, or the screen is not inspected yet. */
  readonly gallery: EvidenceRef | null;
  /** The lenses are still on the screen, so its gallery may yet come. */
  readonly isInspecting?: boolean;
}

const LOADING: GalleryLoad = { status: 'loading' };

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

function StateGalleryView({ gallery, isInspecting = false }: StateGalleryProps) {
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

/** The same gallery file, in the same state of inspection: nothing to render again. */
function isSameGallery(before: StateGalleryProps, after: StateGalleryProps): boolean {
  return before.gallery?.path === after.gallery?.path && before.isInspecting === after.isInspecting;
}

export const StateGallery = memo(StateGalleryView, isSameGallery);
