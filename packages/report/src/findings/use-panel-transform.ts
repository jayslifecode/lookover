import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type ContainerTransform, growFromPin, type Rect } from '@/motion/container-transform';
import { prefersReducedMotion } from '@/motion/reduced';
import { PANEL_SELECTOR } from './finding-panel';

/*
 * The Screens view's side of the pin → panel container transform. It follows the route's finding: when
 * the choice moves from one pinned finding to another, the panel keeps showing the old one while a ghost
 * holding the new one grows out of the new pin, and the new one is swapped in when the ghost lands. From
 * nothing, from a finding without a pin, to one without a pin, or under reduced motion, the new finding is
 * shown at once. A choice made while a ghost is on its way lands that ghost at once and grows from there.
 */

/** A ghost to render into the stage: the finding it holds, and where it grows from and to. */
export interface Ghost {
  readonly findingId: string;
  readonly pinRect: Rect;
  readonly panelRect: Rect;
}

export interface PanelTransform {
  /** The finding the panel shows: the route's, once a transform toward it has landed. */
  readonly shownId: string | null;
  /** The ghost to render while a transform runs. */
  readonly ghost: Ghost | null;
  /** The panel's content (it fades out). */
  readonly contentRef: RefObject<HTMLDivElement | null>;
  /** The rendered ghost. */
  readonly ghostRef: RefObject<HTMLDivElement | null>;
}

const PIN_SELECTOR = '[data-pin-findings]';

/** The pin (or cluster pin) on `stage` that holds `findingId`. */
export function pinOf(stage: ParentNode, findingId: string): HTMLElement | null {
  for (const pin of stage.querySelectorAll<HTMLElement>(PIN_SELECTOR)) {
    if ((pin.dataset.pinFindings ?? '').split(' ').includes(findingId)) return pin;
  }
  return null;
}

/** The ghost for a move from `from` to `to`; `null` when the move is shown at once. */
function ghostFor(stage: HTMLElement | null, from: string | null, to: string | null): Ghost | null {
  if (stage === null || from === null || to === null || from === to || prefersReducedMotion()) return null;
  const pin = pinOf(stage, to);
  const panel = stage.querySelector(PANEL_SELECTOR);
  if (pin === null || panel === null || pinOf(stage, from) === null) return null;
  const panelRect = panel.getBoundingClientRect();
  // A panel not laid out (hidden, or not rendered yet) has no box to grow onto.
  if (panelRect.width === 0 || panelRect.height === 0) return null;
  return { findingId: to, pinRect: pin.getBoundingClientRect(), panelRect };
}

export function usePanelTransform(
  findingId: string | null,
  stageRef: RefObject<HTMLElement | null>,
): PanelTransform {
  const [shownId, setShownId] = useState(findingId);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  // What the panel shows and what the route asked for last, read synchronously between renders.
  const shown = useRef(findingId);
  const target = useRef(findingId);
  const running = useRef<ContainerTransform | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  const show = useCallback((id: string | null) => {
    shown.current = id;
    setShownId(id);
  }, []);

  // Layout effects: what they change is rendered before the browser paints, so nothing flickers.
  useLayoutEffect(() => {
    if (findingId === target.current) return;
    target.current = findingId;
    running.current?.cancel();
    running.current = null;
    const next = ghostFor(stageRef.current, shown.current, findingId);
    if (next === null) show(findingId);
    setGhost(next);
  }, [findingId, stageRef, show]);

  useLayoutEffect(() => {
    if (ghost === null) return;
    const stage = stageRef.current;
    const element = ghostRef.current;
    if (stage === null || element === null) {
      show(ghost.findingId);
      setGhost(null);
      return;
    }
    running.current = growFromPin({
      pinRect: ghost.pinRect,
      panelRect: ghost.panelRect,
      stage,
      ghost: element,
      body: contentRef.current,
      onArrive: () => show(ghost.findingId),
      onDone: () => {
        running.current = null;
        setGhost((current) => (current === ghost ? null : current));
      },
    });
  }, [ghost, stageRef, show]);

  useEffect(() => () => running.current?.cancel(), []);

  return { shownId, ghost, contentRef, ghostRef };
}
