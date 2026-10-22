import { type Ref, useId } from 'react';
import type { ReportState } from '@/data/reduce';
import { PanelContent } from './finding-panel';

/*
 * The copy of the panel that grows out of a pin (motion/container-transform.ts places and animates it):
 * the panel's content for the new finding on a solid tint of --bg-2, with the panel's edge and radius. It
 * has no backdrop blur and no `data-glass`, so the three glass layers stay three while it is on screen.
 * It is a picture of the panel, not a second one: hidden from assistive technology and inert.
 */

const GHOST =
  'pointer-events-none absolute z-[4] flex origin-top-left flex-col overflow-hidden rounded-[18px] border border-glass-edge bg-[color-mix(in_oklab,var(--bg-2)_88%,transparent)] text-ink will-change-[transform,clip-path,opacity]';

export interface PanelGhostProps {
  readonly report: ReportState;
  readonly findingId: string;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

export function PanelGhost({ report, findingId, ref }: PanelGhostProps) {
  const titleId = useId();
  return (
    <div ref={ref} aria-hidden="true" inert className={GHOST}>
      {/* Its content fades in on the way; it starts hidden so nothing shows before the animation does. */}
      <div className="flex min-h-0 flex-1 flex-col opacity-0 will-change-[opacity]">
        <PanelContent report={report} findingId={findingId} titleId={titleId} />
      </div>
    </div>
  );
}
