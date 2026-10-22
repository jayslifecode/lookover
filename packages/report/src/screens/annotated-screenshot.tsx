import type { Finding, Screen } from '@jayslifecode/lookover-core';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { evidenceUrl } from '@/data/api';
import { formatRoute, navigate } from '@/data/route';
import { fixFirst, groups } from '@/data/selectors';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/motion/reduced';
import { isPinnable, LABEL_INSET, type PinPlacement, placePins } from './pins';
import { SEVERITY_DOT, SEVERITY_FILL, SEVERITY_LABEL } from './severity';

/*
 * The screen's full-page screenshot at the column's width, with a pin on each confirmed step finding
 * (spec §11; placement in pins.ts). The image is measured when it loads and whenever its frame resizes
 * (a ResizeObserver), and the labels once they are rendered and again when the web fonts are ready, so
 * the pins stay on their targets at any width. A pin is a button named `<n>. <title>`; its label is a
 * tooltip that shows on hover and keyboard focus only; the ring marks the route's selected finding;
 * clicking it selects that finding in the route. Pins are tinted dots, not glass: they float over any
 * content, so the focus ring is two-tone (the 2 px accent outline over a 2 px halo of --bg-2) and the
 * label is a solid --bg-2 surface. The press spring is a Web Animation of `transform` on the dot, and
 * does not run under reduced motion. Findings with no place on the screenshot are listed below it.
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

/** The motion study's dot bounce: down, past its size, and back. */
const PRESS_KEYFRAMES: Keyframe[] = [
  { transform: 'scale(1)' },
  { transform: 'scale(0.86)', offset: 0.3 },
  { transform: 'scale(1.18)', offset: 0.62 },
  { transform: 'scale(1)' },
];
const PRESS_MS = 460;
const NOT_MEASURED: ReadonlyMap<string, number> = new Map();
const LABEL_SELECTOR = '[data-pin-label]';

const FRAME = 'relative overflow-hidden rounded-lg border border-line bg-bg-2';
/** The button is the dot's box; the label hangs off it. Hover and focus lift it above its neighbours. */
const PIN =
  'group absolute z-[2] size-6 cursor-pointer rounded-full border-0 bg-transparent p-0 hover:z-[3] focus-visible:z-[3] focus-visible:shadow-[0_0_0_4px_var(--bg-2)]';
/** The severity fill, a 1 px light edge and a soft shadow; the selection ring is its `::after`. */
const DOT =
  'relative grid size-6 place-items-center rounded-full border border-white/85 font-bold font-mono text-[11px] leading-none shadow-[0_1px_3px_rgba(0,0,0,0.35),0_4px_12px_rgba(0,0,0,0.22)] will-change-transform after:pointer-events-none after:absolute after:-inset-1 after:rounded-full after:border-2 after:border-accent after:opacity-0 after:transition-opacity after:duration-200 group-aria-[current=true]:after:opacity-100';
/** Hidden until the pin is hovered or focused; it rises (or drops) 6 px into place as it shows. */
const LABEL =
  'pointer-events-none absolute left-1/2 max-w-(--label-max) translate-x-[calc(-50%+var(--lx,0px))] overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-line-strong bg-bg-2 px-2.5 py-[5px] font-semibold text-[12px] text-ink leading-4 opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.22)] transition-[opacity,translate] duration-200 ease-(--ease-out) group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100';
const LABEL_SIDE = {
  above: 'bottom-[calc(100%+8px)] translate-y-1.5',
  below: 'top-[calc(100%+8px)] -translate-y-1.5',
} as const;

/** A plain message in place of something the view cannot show. */
export function Notice({ children }: { readonly children: string }) {
  return (
    <p role="status" className="rounded-lg border border-line bg-bg-1 p-6 text-ink-2">
      {children}
    </p>
  );
}

export function AnnotatedScreenshot({ screen, findings, selectedId }: AnnotatedScreenshotProps) {
  if (screen.status === 'navigation-failed') {
    const reason = screen.error ?? 'no reason was recorded';
    return <Notice>{`This page could not be loaded (${reason}), so nothing on it was captured.`}</Notice>;
  }
  const url = screen.screenshot === null ? null : evidenceUrl(screen.screenshot);
  if (url === null) return <Notice>No screenshot was kept for this screen.</Notice>;
  // A new screen starts measuring afresh.
  return (
    <PinnedScreenshot key={screen.id} screen={screen} url={url} findings={findings} selectedId={selectedId} />
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

function PinnedScreenshot({ screen, url, findings, selectedId }: AnnotatedScreenshotProps & { url: string }) {
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
      <img
        ref={image}
        src={url}
        alt={`Screenshot of ${screen.title} (${screen.route})`}
        decoding="async"
        onLoad={measure}
        className="block h-auto w-full"
      />
      {/* Each pin is placed against the list, which covers the image; the items take no room. */}
      <ul aria-label="Pinned findings" className="absolute inset-0 m-0 list-none p-0" style={layer}>
        {placements.map((placement) => (
          <li key={placement.finding.id}>
            <Pin
              screenId={screen.id}
              placement={placement}
              isSelected={placement.finding.id === selectedId}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pin({
  screenId,
  placement,
  isSelected,
}: {
  readonly screenId: string;
  readonly placement: PinPlacement;
  readonly isSelected: boolean;
}) {
  const dot = useRef<HTMLSpanElement>(null);
  const bounce = useRef<Animation | null>(null);
  const { finding, number, left, top, label, labelShift } = placement;

  const select = () => {
    const target = dot.current;
    if (target !== null && typeof target.animate === 'function' && !prefersReducedMotion()) {
      bounce.current?.cancel();
      bounce.current = target.animate(PRESS_KEYFRAMES, { duration: PRESS_MS, easing: 'linear' });
    }
    navigate({ view: 'screens', screenId, findingId: finding.id });
  };

  return (
    <button
      type="button"
      aria-label={`${number}. ${finding.title}`}
      aria-current={isSelected ? 'true' : undefined}
      className={PIN}
      style={{ left, top, '--lx': `${labelShift}px` } as CSSProperties}
      onClick={select}
    >
      <span ref={dot} aria-hidden="true" className={cn(DOT, SEVERITY_FILL[finding.severity])}>
        {number}
      </span>
      <span data-pin-label={finding.id} aria-hidden="true" className={cn(LABEL, LABEL_SIDE[label])}>
        {finding.title}
      </span>
    </button>
  );
}

/**
 * The screen's findings that have no place on the screenshot (occurrence findings, and step findings
 * without a target), fix-first, each a link that selects it.
 */
export function UnpinnedFindings({ screen, findings, selectedId }: AnnotatedScreenshotProps) {
  const titleId = useId();
  const unpinned = fixFirst(groups(findings.filter((finding) => !isPinnable(finding)))).flatMap(
    (group) => group.findings,
  );
  if (unpinned.length === 0) return null;
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-line bg-bg-1 p-4">
      <h2 id={titleId} className="font-semibold text-[15px]">
        Also on this screen
      </h2>
      <p className="mt-0.5 text-[13px] text-ink-2">
        About the page as a whole, so not pinned to a place on it.
      </p>
      <ul className="mt-2 grid gap-1">
        {unpinned.map((finding) => (
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
