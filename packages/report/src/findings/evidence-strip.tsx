import type { EvidenceItem } from '@jayslifecode/lookover-core';
import { useEffect, useId, useRef, useState } from 'react';
import { evidenceUrl } from '@/data/api';
import { cn } from '@/lib/utils';
import { ON_GLASS_FOCUS, PANEL_SECTION, SECONDARY_BUTTON } from './panel-styles';

/*
 * The finding's pictures: its crops (the element at rest and in each state) and screenshots, small, in a
 * row. A press opens one enlarged in a native modal `<dialog>`, which Escape or the Close button closes
 * and which hands focus back to the picture pressed. The dialog is a solid surface: it is not one of the
 * three glass layers.
 */

const PICTURE_KINDS: ReadonlySet<EvidenceItem['kind']> = new Set(['crop', 'screenshot']);

interface Picture {
  readonly label: string;
  readonly url: string;
}

function picturesOf(evidence: readonly EvidenceItem[]): Picture[] {
  return evidence.flatMap((item) => {
    const url = PICTURE_KINDS.has(item.kind) ? evidenceUrl(item.ref) : null;
    return url === null ? [] : [{ label: item.label, url }];
  });
}

function openModal(dialog: HTMLDialogElement): void {
  // Every browser the report supports has showModal; the attribute keeps the picture reachable without it.
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function Enlarged({
  picture,
  onClosed,
}: {
  readonly picture: Picture | null;
  readonly onClosed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && picture !== null && !element.open) openModal(element);
  }, [picture]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClosed}
      className="m-auto max-h-[92vh] max-w-[min(92vw,1200px)] rounded-[18px] border border-line-strong bg-bg-2 p-3 text-ink shadow-[0_24px_70px_rgba(0,0,0,0.5)] backdrop:bg-black/60"
    >
      {picture === null ? null : (
        <figure className="m-0 grid gap-2">
          <img
            src={picture.url}
            alt={picture.label}
            className="block h-auto max-h-[78vh] w-auto max-w-full rounded-md"
          />
          <figcaption className="flex items-center justify-between gap-3">
            <span id={titleId} className="font-semibold text-[13px]">
              {picture.label}
            </span>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => dialog.current?.close()}>
              Close
            </button>
          </figcaption>
        </figure>
      )}
    </dialog>
  );
}

export function EvidenceStrip({ evidence }: { readonly evidence: readonly EvidenceItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const pressed = useRef<HTMLButtonElement | null>(null);
  const pictures = picturesOf(evidence);
  if (pictures.length === 0) return null;
  const closed = () => {
    setOpenIndex(null);
    pressed.current?.focus();
  };
  return (
    <div className={PANEL_SECTION}>
      <ul aria-label="Evidence" className="m-0 flex list-none gap-2 overflow-x-auto p-0.5">
        {pictures.map((picture, index) => (
          <li key={picture.url} className="shrink-0">
            <button
              type="button"
              aria-label={`Enlarge ${picture.label}`}
              className={cn(
                'grid w-28 cursor-zoom-in gap-1 rounded-[8px] border border-line-strong bg-transparent p-1 text-left text-[11.5px] text-ink',
                ON_GLASS_FOCUS,
              )}
              onClick={(event) => {
                pressed.current = event.currentTarget;
                setOpenIndex(index);
              }}
            >
              <img
                src={picture.url}
                alt=""
                className="block h-16 w-full rounded-[5px] bg-bg-2 object-contain"
              />
              <span className="truncate">{picture.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <Enlarged picture={openIndex === null ? null : (pictures[openIndex] ?? null)} onClosed={closed} />
    </div>
  );
}
