import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { useLiquidPill } from '@/motion/use-liquid-pill';

/*
 * The view switcher: WAI-ARIA tabs under the liquid pill (spec §11, motion study `.seg` and `.liq`). It
 * sits inside the top bar's glass and has no glass of its own. Every label is --ink, the one ink that
 * reads on glass over any content; the pill marks the selection. A tab is at least 36 px tall and 44 px
 * wide. The focus ring is the 2 px accent outline (tokens.css) over a 2 px halo of the solid surface
 * colour, so it holds 3:1 over whatever the glass floats over.
 */

export interface SegmentedItem<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface SegmentedControlProps<V extends string> {
  readonly items: readonly SegmentedItem<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
  /** The tablist's accessible name. */
  readonly label: string;
  /** The id of the panel the tabs show, for `aria-controls`. */
  readonly controls?: string;
  readonly className?: string;
}

const TAB_SELECTOR = '[role="tab"]';

/** The motion study's `.seg`: 5 px of padding, which the pill's inset matches. */
const BAR = 'relative inline-flex touch-none select-none gap-0.5 overflow-hidden rounded-full p-[5px]';
/** `.liq`: a full-width layer the hook clips to the pill's two edges; its colour is the edge line. */
const PILL =
  'pointer-events-none absolute top-[5px] left-0 h-[calc(100%-10px)] bg-pill-edge will-change-[transform,clip-path]';
/** `.liq .fill`: clipped 1 px inside the edge. */
const FILL =
  'absolute inset-0 overflow-hidden bg-[linear-gradient(180deg,var(--pill-a),var(--pill-b))] will-change-[clip-path]';
/** `.liq .hl`: the specular highlight, moved with translate3d only. */
const HIGHLIGHT =
  'absolute inset-0 bg-[radial-gradient(42%_130%_at_50%_-20%,rgba(255,255,255,.30),transparent_72%)] will-change-transform';
const TAB =
  'relative z-1 min-h-9 min-w-11 cursor-pointer rounded-full px-4 py-2 font-semibold text-[13px] text-ink will-change-transform focus-visible:shadow-[0_0_0_4px_var(--bg-2)]';

/** The tab a key moves to: the arrows step and wrap, as WAI-ARIA tabs do; Home and End go to the ends. */
function tabForKey(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Moves keyboard focus to tab `index` when it is on one of the tabs (after a key, or a press and drag). */
function followFocus(bar: HTMLElement | null, index: number): void {
  if (bar === null || !bar.contains(document.activeElement)) return;
  bar.querySelectorAll<HTMLElement>(TAB_SELECTOR).item(index)?.focus();
}

export function SegmentedControl<V extends string>({
  items,
  value,
  onChange,
  label,
  controls,
  className,
}: SegmentedControlProps<V>) {
  const active = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );
  // Called for a click, a key or a drag's release.
  const pill = useLiquidPill(active, (index) => {
    const item = items[index];
    if (item !== undefined && item.value !== value) onChange(item.value);
    followFocus(pill.barRef.current, index);
  });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = tabForKey(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    pill.select(next);
  };

  return (
    <div ref={pill.barRef} role="tablist" aria-label={label} className={cn(BAR, className)}>
      <span ref={pill.pillRef} data-pill="" aria-hidden="true" className={PILL}>
        <span ref={pill.fillRef} className={FILL}>
          <span ref={pill.highlightRef} className={HIGHLIGHT} />
        </span>
      </span>
      {items.map((item, index) => {
        const isSelected = index === active;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={controls}
            tabIndex={isSelected ? 0 : -1}
            className={TAB}
            onClick={() => {
              if (!pill.isDragging()) pill.select(index);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
