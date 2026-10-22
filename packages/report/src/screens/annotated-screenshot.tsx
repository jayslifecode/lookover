import type { Finding, Screen } from '@jayslifecode/lookover-core';
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { evidenceUrl } from '@/data/api';
import { formatRoute } from '@/data/route';
import { cn } from '@/lib/utils';
import { Pin } from './pin';
import { fixFirstOrder, isPinnable, LABEL_INSET, type PinPlacement, placePins } from './pins';
import { ScreenshotImage } from './screenshot-image';
import { SEVERITY_DOT, SEVERITY_LABEL } from './severity';

/*
 * The screen's full-page screenshot at the column's width, with a pin on each confirmed step finding
 * (spec §11; placement and clustering in pins.ts, the pins themselves in pin.tsx). The image is
 * measured when it loads and whenever its frame resizes (a ResizeObserver), and the labels once they are
 * rendered and again when the web fonts are ready, so the pins stay on their targets at any width.
 * Findings with no place on the screenshot are listed below it; while there is no image to pin on (the
 * screen failed, kept no screenshot, its screenshot failed to load or is not measured yet) every finding
 * is listed there, so none is out of reach.
 *
 * Choosing a finding is cheap: the image and the pins render through `memo`, the placement is computed
 * from the screen's findings and the image's sizes only, and the selected id reaches only the pin that
 * holds it (the ring marks it), so a `?f=` change renders one or two pins and nothing else here.
 */

export interface AnnotatedScreenshotProps {
  readonly screen: Screen;
  /** The screen's confirmed findings. */
  readonly findings: readonly Finding[];
  /** The route's selected finding. */
  readonly selectedId: string | null;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

const NOT_MEASURED: ReadonlyMap<string, number> = new Map();
const NO_BOX: Size = { width: 0, height: 0 };
const LABEL_SELECTOR = '[data-pin-label]';
const MemoImage = memo(ScreenshotImage);
const MemoPin = memo(Pin);
const FRAME = 'relative overflow-hidden rounded-lg border border-line bg-bg-2';

/** A plain message in place of something the view cannot show. */
export function Notice({ children }: { readonly children: string }) {
  return (
    <p role="status" className="rounded-lg border border-line bg-bg-1 p-6 text-ink-2">
      {children}
    </p>
  );
}

export const AnnotatedScreenshot = memo(function AnnotatedScreenshot(props: AnnotatedScreenshotProps) {
  // A new screen starts afresh: its image is measured again, and may fail to load on its own.
  return <ScreenshotAndFindings key={props.screen.id} {...props} />;
});

/** The selected id for the pin of `placement`: the id when the pin holds it, else `null`, which holds still. */
function selectionIn(placement: PinPlacement, selectedId: string | null): string | null {
  if (selectedId === null) return null;
  return placement.members.some(({ finding }) => finding.id === selectedId) ? selectedId : null;
}

function ScreenshotAndFindings({ screen, findings, selectedId }: AnnotatedScreenshotProps) {
  const [isBroken, setBroken] = useState(false);
  const [isMeasured, setMeasured] = useState(false);
  const markBroken = useCallback(() => setBroken(true), []);
  const url = screen.screenshot === null ? null : evidenceUrl(screen.screenshot);
  const canPin = screen.status !== 'navigation-failed' && url !== null && !isBroken;
  return (
    <>
      {screen.status === 'navigation-failed' ? (
        <Notice>{`This page could not be loaded (${screen.error ?? 'no reason was recorded'}), so nothing on it was captured.`}</Notice>
      ) : url === null ? (
        <Notice>No screenshot was kept for this screen.</Notice>
      ) : isBroken ? (
        <Notice>The screenshot could not be loaded.</Notice>
      ) : (
        <PinnedScreenshot
          screen={screen}
          url={url}
          findings={findings}
          selectedId={selectedId}
          onError={markBroken}
          onMeasured={setMeasured}
        />
      )}
      <FindingList
        screen={screen}
        findings={findings}
        selectedId={selectedId}
        arePinsShown={canPin && isMeasured}
      />
    </>
  );
}

/** The labels' rendered widths by finding id; `known` itself when nothing changed (or nothing is laid out). */
function measuredLabels(known: ReadonlyMap<string, number>, root: ParentNode): ReadonlyMap<string, number> {
  const measured = [...root.querySelectorAll<HTMLElement>(LABEL_SELECTOR)]
    .map((label) => [label.dataset.pinLabel ?? '', label.offsetWidth] as const)
    .filter(([id, width]) => id !== '' && width > 0);
  const isSame = measured.length === known.size && measured.every(([id, width]) => known.get(id) === width);
  return isSame ? known : new Map(measured);
}

interface PinnedScreenshotProps extends AnnotatedScreenshotProps {
  readonly url: string;
  /** The image could not be loaded. */
  readonly onError: () => void;
  /** Whether the image has been measured, so the pins are drawn. */
  readonly onMeasured: (isMeasured: boolean) => void;
}

function PinnedScreenshot({ screen, url, findings, selectedId, onError, onMeasured }: PinnedScreenshotProps) {
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [shownWidth, setShownWidth] = useState(0);
  const [labelWidths, setLabelWidths] = useState(NOT_MEASURED);

  const measure = useCallback(() => {
    const shot = image.current;
    if (shot === null || shot.naturalWidth === 0) return;
    const { naturalWidth: width, naturalHeight: height } = shot;
    setNatural((known) => (known?.width === width && known.height === height ? known : { width, height }));
    setShownWidth(shot.clientWidth);
  }, []);

  const measureLabels = useCallback(() => {
    const root = frame.current;
    if (root !== null) setLabelWidths((known) => measuredLabels(known, root));
  }, []);

  useEffect(() => {
    // An image already in the cache may have loaded before React listened.
    if (image.current?.complete === true) measure();
    if ('fonts' in document) void document.fonts.ready.then(measureLabels);
    const root = frame.current;
    if (root === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure, measureLabels]);

  const box = useMemo<Size | null>(
    () =>
      natural === null ? null : { width: shownWidth, height: (natural.height * shownWidth) / natural.width },
    [natural, shownWidth],
  );
  const isMeasured = box !== null;
  useEffect(() => {
    onMeasured(isMeasured);
  }, [isMeasured, onMeasured]);
  const placements = useMemo(
    () =>
      box === null || natural === null ? [] : placePins(findings, natural.width, box.width, box, labelWidths),
    [findings, natural, box, labelWidths],
  );
  // Each placement renders its labels; measuring them may move the pins once more, then it settles.
  useLayoutEffect(() => {
    if (placements.length > 0) measureLabels();
  }, [placements, measureLabels]);

  const layer = { '--label-max': `${Math.max((box?.width ?? 0) - 2 * LABEL_INSET, 0)}px` } as CSSProperties;
  return (
    <div ref={frame} className={FRAME}>
      <MemoImage
        url={url}
        alt={`Screenshot of ${screen.title} (${screen.route})`}
        imageRef={image}
        onLoad={measure}
        onError={onError}
      />
      {/* Each pin is placed against the list, which covers the image; the items take no room. */}
      <ul aria-label="Pinned findings" className="absolute inset-0 m-0 list-none p-0" style={layer}>
        {placements.map((placement) => (
          <li key={placement.finding.id}>
            <MemoPin
              screenId={screen.id}
              placement={placement}
              box={box ?? NO_BOX}
              selectedId={selectionIn(placement, selectedId)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Fix-first, each a link that selects it: the screen's findings that have no place on the screenshot
 * (occurrence findings, and step findings without a target) while the pins are shown, else all of them.
 */
function FindingList({
  screen,
  findings,
  selectedId,
  arePinsShown,
}: AnnotatedScreenshotProps & { readonly arePinsShown: boolean }) {
  const titleId = useId();
  const listed = fixFirstOrder(arePinsShown ? findings.filter((finding) => !isPinnable(finding)) : findings);
  if (listed.length === 0) return null;
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-line bg-bg-1 p-4">
      <h2 id={titleId} className="font-semibold text-[15px]">
        {arePinsShown ? 'Also on this screen' : 'Findings on this screen'}
      </h2>
      <p className="mt-0.5 text-[13px] text-ink-2">
        {arePinsShown
          ? 'About the page as a whole, so not pinned to a place on it.'
          : 'Listed here while there is no screenshot to pin them on.'}
      </p>
      <ul className="mt-2 grid gap-1">
        {listed.map((finding) => (
          <li key={finding.id}>
            <a
              href={formatRoute({ view: 'screens', screenId: screen.id, findingId: finding.id })}
              aria-current={finding.id === selectedId ? 'true' : undefined}
              className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-ink hover:bg-bg-2 aria-[current=true]:bg-bg-2 aria-[current=true]:ring-1 aria-[current=true]:ring-accent"
            >
              <span
                aria-hidden="true"
                className={cn('size-2 shrink-0 rounded-full', SEVERITY_DOT[finding.severity])}
              />
              <span className="shrink-0 text-[12px] text-ink-2">{SEVERITY_LABEL[finding.severity]}</span>
              <span className="min-w-0">{finding.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
