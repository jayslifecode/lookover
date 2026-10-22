import type { ReactNode } from 'react';
import { Glass } from '@/glass/glass';
import { ThemeToggle } from '@/theme/theme-toggle';
import { LiveIndicator, type LiveStatus } from './live-indicator';

/*
 * The floating top bar: the first of the report's three glass surfaces. It names the run, says where it
 * is, holds the view switcher and the cost readout, and the theme toggle. All its text is --ink, the
 * one ink that stays readable on glass over any content (see tokens.css). Below `sm` the view switcher
 * takes a row of its own, so the bar fits a 390 px screen.
 */

export interface TopBarProps {
  /** The run's id, or a stand-in while it loads. */
  readonly runName: string;
  readonly baseUrl: string | null;
  /** `null` while the run is not known yet. */
  readonly status: LiveStatus | null;
  /** The run's event stream dropped and is reconnecting. */
  readonly isReconnecting?: boolean;
  /** The view switcher. */
  readonly nav?: ReactNode;
  /** What the judge model cost. */
  readonly cost?: ReactNode;
}

export function TopBar({ runName, baseUrl, status, isReconnecting = false, nav, cost }: TopBarProps) {
  return (
    <Glass
      as="header"
      className="sticky top-3.5 z-20 mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-3 gap-y-0.5 rounded-[26px] py-1.5 pr-1.5 pl-4 sm:flex-nowrap sm:gap-4 sm:rounded-full sm:pl-5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="shrink-0 font-bold text-[15px] tracking-tight">Lookover</span>
        <div className="min-w-0 leading-tight">
          <p className="truncate font-mono font-medium text-[12px]">{runName}</p>
          {baseUrl === null ? null : <p className="truncate font-mono text-[11.5px]">{baseUrl}</p>}
        </div>
      </div>
      {nav === undefined ? null : (
        <div className="order-last flex w-full justify-center sm:order-none sm:w-auto sm:shrink-0">{nav}</div>
      )}
      <div className="flex shrink-0 items-center gap-3">
        {cost}
        {status === null ? null : <LiveIndicator status={status} isReconnecting={isReconnecting} />}
        <ThemeToggle />
      </div>
    </Glass>
  );
}
