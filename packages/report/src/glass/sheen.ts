/*
 * The highlight that follows the pointer over a glass surface (spec §11, smoothness rule 2): a
 * fixed-size element moved with `translate3d` only, so the compositor moves it and the blurred surface
 * under it never re-renders. Pointer events can arrive several times a frame; the spot moves once per
 * frame, to where the pointer was last.
 */

/** The spot's size, as in glass.css `.glass-spot`; it is centred on the pointer. */
export const SPOT_WIDTH = 260;
export const SPOT_HEIGHT = 180;

/** Moves `spot` under the pointer while it is over `surface`. Returns the function that stops it. */
export function followPointer(surface: HTMLElement, spot: HTMLElement): () => void {
  let frame: number | null = null;
  let pointer = { x: 0, y: 0 };

  const moveSpot = () => {
    frame = null;
    const box = surface.getBoundingClientRect();
    const x = pointer.x - box.left - SPOT_WIDTH / 2;
    const y = pointer.y - box.top - SPOT_HEIGHT / 2;
    spot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const onPointerMove = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    if (frame === null) frame = requestAnimationFrame(moveSpot);
  };

  surface.addEventListener('pointermove', onPointerMove, { passive: true });
  return () => {
    surface.removeEventListener('pointermove', onPointerMove);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
