import { type HTMLAttributes, type ReactNode, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion, useReducedTransparency } from '@/motion/reduced';
import { followPointer } from './sheen';

/*
 * A glass surface (spec §11), for the three places a layer floats over content: the top bar, the pins
 * and the finding panel. It is frosted where the browser has `backdrop-filter`, refracts through the
 * `#lens` filter when `lens` is asked for and the browser can apply it (Chromium), and is a solid
 * `--bg-2` surface under reduced transparency or reduced motion, or without `backdrop-filter`.
 * The styles are in glass.css.
 */

export type GlassElement = 'div' | 'header' | 'aside' | 'nav' | 'section' | 'span';
export type GlassLook = 'frosted' | 'lens' | 'solid';

export interface GlassProps extends HTMLAttributes<HTMLElement> {
  /** The element to render. Default `div`. */
  readonly as?: GlassElement;
  /** Refract the backdrop through the `#lens` filter (small surfaces only: it is CPU-heavy). */
  readonly lens?: boolean;
  readonly children?: ReactNode;
}

export const LENS_FILTER_ID = 'lens';
const BLUR_PROBE = 'blur(1px)';
const LENS_PROBE = `url(#${LENS_FILTER_ID})`;

function supportsBackdropFilter(value: string): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  return CSS.supports('backdrop-filter', value) || CSS.supports('-webkit-backdrop-filter', value);
}

function lookOf(lens: boolean, isReduced: boolean): GlassLook {
  if (isReduced || !supportsBackdropFilter(BLUR_PROBE)) return 'solid';
  return lens && supportsBackdropFilter(LENS_PROBE) ? 'lens' : 'frosted';
}

export function Glass({ as: Element = 'div', lens = false, className, children, ...rest }: GlassProps) {
  const isReducedTransparency = useReducedTransparency();
  const isReducedMotion = useReducedMotion();
  const look = lookOf(lens, isReducedTransparency || isReducedMotion);
  const isSolid = look === 'solid';
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const [spot, setSpot] = useState<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (surface === null || spot === null) return;
    return followPointer(surface, spot);
  }, [surface, spot]);

  return (
    <Element
      {...rest}
      ref={setSurface}
      data-glass={look}
      className={cn('glass', look === 'lens' && 'glass-lens', isSolid && 'glass-solid', className)}
    >
      {isSolid ? null : <span ref={setSpot} className="glass-spot" data-glass-spot="" aria-hidden="true" />}
      {children}
    </Element>
  );
}

/** The static displacement the lens look refracts through. Rendered once, by the app. */
export function LensFilter() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <filter id={LENS_FILTER_ID} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.010 0.018" numOctaves={2} seed={7} result="n" />
        <feGaussianBlur in="n" stdDeviation={1.2} result="nb" />
        <feDisplacementMap in="SourceGraphic" in2="nb" scale={7} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
