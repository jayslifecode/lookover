import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { navigate } from '@/data/route';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/motion/reduced';
import { type PinPlacement, pinFace, pinName, popoverBox, type ScreenshotBox } from './pins';
import { SEVERITY_DOT, SEVERITY_FILL, SEVERITY_LABEL } from './severity';

/*
 * A pin on the screenshot (placement in pins.ts). A pin is a button named `<n>. <title>` that selects its
 * finding in the route; a cluster pin (`<count> findings near <first title>`) opens a small solid
 * popover, a listbox of its findings in fix-first order with their own numbers: the arrows, Home and End
 * move, Enter or Space selects (and closes), Escape closes and gives focus back to the pin, and a click
 * outside closes. The label is a tooltip that shows on hover and keyboard focus only; the ring marks the
 * route's selected finding (on a cluster: one of its findings). Pins are tinted dots, not glass: they
 * float over any content, so the focus ring is two-tone (the 2 px accent outline over a 2 px halo of
 * --bg-2), and the label and the popover are solid --bg-2 surfaces. The press spring is a Web Animation
 * of `transform` on the dot, and does not run under reduced motion.
 */

export interface PinProps {
  readonly screenId: string;
  readonly placement: PinPlacement;
  /** The screenshot as shown: the popover stays inside it. */
  readonly box: ScreenshotBox;
  /** The route's selected finding. */
  readonly selectedId: string | null;
}

/** The motion study's dot bounce: down, past its size, and back. */
const PRESS_KEYFRAMES: Keyframe[] = [
  { transform: 'scale(1)' },
  { transform: 'scale(0.86)', offset: 0.3 },
  { transform: 'scale(1.18)', offset: 0.62 },
  { transform: 'scale(1)' },
];
const PRESS_MS = 460;

/** The button is the dot's box; the label hangs off it. Hover and focus lift it above its neighbours. */
const PIN =
  'group absolute z-[2] size-6 cursor-pointer rounded-full border-0 bg-transparent p-0 hover:z-[3] focus-visible:z-[3] focus-visible:shadow-[0_0_0_4px_var(--bg-2)] aria-expanded:z-[4]';
/** The severity fill, a 1 px light edge and a soft shadow; the selection ring is its `::after`. */
const DOT =
  'relative grid size-6 place-items-center rounded-full border border-white/85 font-bold font-mono text-[11px] leading-none shadow-[0_1px_3px_rgba(0,0,0,0.35),0_4px_12px_rgba(0,0,0,0.22)] will-change-transform after:pointer-events-none after:absolute after:-inset-1 after:rounded-full after:border-2 after:border-accent after:opacity-0 after:transition-opacity after:duration-200 group-aria-[current=true]:after:opacity-100';
/** Hidden until the pin is hovered or focused (and while its popover is open); it rises 6 px into place. */
const LABEL =
  'pointer-events-none absolute left-1/2 max-w-(--label-max) translate-x-[calc(-50%+var(--lx,0px))] whitespace-nowrap border border-line-strong bg-bg-2 px-2.5 py-[5px] font-semibold text-[12px] text-ink leading-4 opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.22)] transition-[opacity,translate] duration-200 ease-(--ease-out) group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 group-aria-expanded:invisible';
const LABEL_SIDE = {
  above: 'bottom-[calc(100%+8px)] translate-y-1.5',
  below: 'top-[calc(100%+8px)] -translate-y-1.5',
} as const;
const POPOVER =
  'absolute z-[5] grid grid-cols-1 content-start overflow-y-auto rounded-md border border-line-strong bg-bg-2 p-1 text-ink shadow-[0_12px_32px_rgba(0,0,0,0.3)] focus-visible:shadow-[0_0_0_4px_var(--bg-2),0_12px_32px_rgba(0,0,0,0.3)]';
const OPTION =
  'flex min-h-8 cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 py-1 text-[12.5px] hover:bg-bg-1 aria-selected:bg-[color-mix(in_oklab,var(--accent)_18%,var(--bg-2))] aria-selected:outline-2 aria-selected:outline-accent aria-selected:-outline-offset-2';

function pinStyle({ left, top, labelShift }: PinPlacement): CSSProperties {
  return { left, top, '--lx': `${labelShift}px` } as CSSProperties;
}

/** The press spring on the dot; a new press replaces the one still running. */
function usePress(): (dot: HTMLElement | null) => void {
  const bounce = useRef<Animation | null>(null);
  return useCallback((dot) => {
    if (dot === null || typeof dot.animate !== 'function' || prefersReducedMotion()) return;
    bounce.current?.cancel();
    bounce.current = dot.animate(PRESS_KEYFRAMES, { duration: PRESS_MS, easing: 'linear' });
  }, []);
}

function PinFace({ placement, dot }: { placement: PinPlacement; dot: RefObject<HTMLSpanElement | null> }) {
  const isCluster = placement.members.length > 1;
  return (
    <>
      <span ref={dot} aria-hidden="true" className={cn(DOT, SEVERITY_FILL[placement.severity])}>
        {pinFace(placement)}
      </span>
      <span
        data-pin-label={placement.finding.id}
        aria-hidden="true"
        className={cn(LABEL, LABEL_SIDE[placement.label], isCluster ? 'rounded-[14px]' : 'rounded-full')}
      >
        {placement.labelLines.map((line, index) => (
          // A cluster's titles can repeat; the lines never move.
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed per placement
          <span key={index} className="block truncate">
            {line}
          </span>
        ))}
      </span>
    </>
  );
}

function SinglePin({ screenId, placement, selectedId }: PinProps) {
  const dot = useRef<HTMLSpanElement>(null);
  const press = usePress();
  const select = () => {
    press(dot.current);
    navigate({ view: 'screens', screenId, findingId: placement.finding.id });
  };
  return (
    <button
      type="button"
      aria-label={pinName(placement)}
      aria-current={placement.finding.id === selectedId ? 'true' : undefined}
      className={PIN}
      style={pinStyle(placement)}
      onClick={select}
    >
      <PinFace placement={placement} dot={dot} />
    </button>
  );
}

/** The option a key moves to: the arrows step and wrap, Home and End go to the ends. */
function optionForKey(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

interface PopoverProps extends PinProps {
  readonly id: string;
  readonly anchor: RefObject<HTMLButtonElement | null>;
  readonly onChoose: (findingId: string) => void;
  readonly onClose: (shouldRefocus: boolean) => void;
}

function ClusterPopover({ id, placement, box, selectedId, anchor, onChoose, onClose }: PopoverProps) {
  const list = useRef<HTMLDivElement>(null);
  const { members } = placement;
  const [active, setActive] = useState(() =>
    Math.max(
      members.findIndex(({ finding }) => finding.id === selectedId),
      0,
    ),
  );
  const optionId = (index: number) => `${id}-option-${index}`;
  const position = popoverBox(placement, members.length, box);

  useEffect(() => {
    list.current?.focus();
  }, []);
  useEffect(() => {
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, active]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target !== null && (list.current?.contains(target) || anchor.current?.contains(target))) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [anchor, onClose]);

  const choose = (index: number) => {
    const member = members[index];
    if (member !== undefined) onChoose(member.finding.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = optionForKey(event.key, active, members.length);
    if (next !== null) setActive(next);
    else if (event.key === 'Enter' || event.key === ' ') choose(active);
    else if (event.key === 'Escape') onClose(true);
    else return;
    event.preventDefault();
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const option = event.target instanceof Element ? event.target.closest('[data-option]') : null;
    if (option instanceof HTMLElement) choose(Number(option.dataset.option));
  };
  // Focus leaving for anything but the pin (whose own click toggles the popover) closes it.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (event.currentTarget.contains(next) || anchor.current?.contains(next)))
      return;
    onClose(false);
  };

  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      tabIndex={-1}
      aria-label={`Findings near ${placement.finding.title}`}
      aria-activedescendant={optionId(active)}
      className={POPOVER}
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        [position.side === 'below' ? 'top' : 'bottom']: position.edge,
      }}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onBlur={onBlur}
    >
      {members.map(({ finding, number }, index) => (
        <div
          key={finding.id}
          id={optionId(index)}
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          data-option={index}
          className={OPTION}
        >
          <span className="min-w-0 truncate">{`${number}. ${finding.title}`}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-2">
            <span aria-hidden="true" className={cn('size-2 rounded-full', SEVERITY_DOT[finding.severity])} />
            {SEVERITY_LABEL[finding.severity]}
          </span>
        </div>
      ))}
    </div>
  );
}

function ClusterPin(props: PinProps) {
  const { screenId, placement, selectedId } = props;
  const [isOpen, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const press = usePress();
  const listId = useId();
  const close = useCallback((shouldRefocus: boolean) => {
    setOpen(false);
    if (shouldRefocus) button.current?.focus();
  }, []);
  const choose = useCallback(
    (findingId: string) => {
      navigate({ view: 'screens', screenId, findingId });
      close(true);
    },
    [screenId, close],
  );
  const hasSelected = placement.members.some(({ finding }) => finding.id === selectedId);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={pinName(placement)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-current={hasSelected ? 'true' : undefined}
        className={PIN}
        style={pinStyle(placement)}
        onClick={() => {
          press(dot.current);
          setOpen((open) => !open);
        }}
      >
        <PinFace placement={placement} dot={dot} />
      </button>
      {isOpen ? (
        <ClusterPopover {...props} id={listId} anchor={button} onChoose={choose} onClose={close} />
      ) : null}
    </>
  );
}

export function Pin(props: PinProps) {
  return props.placement.members.length > 1 ? <ClusterPin {...props} /> : <SinglePin {...props} />;
}
