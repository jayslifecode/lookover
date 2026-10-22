import { Component, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * A part of the page that throws while rendering (a view, the finding panel) is replaced by a solid
 * notice instead of blanking the page: what could not be shown, the first line of the error (a stack or
 * anything after the first line is left out, as it may name local paths), and a Reload button. A new
 * `resetKey` (another view, another finding) tries the children again. React reports the error itself.
 */

export interface ErrorBoundaryProps {
  /** What the boundary holds, as the notice names it: `Screens view`, `finding`. */
  readonly label: string;
  /** When it changes, the children are tried again. */
  readonly resetKey?: unknown;
  /** What Reload does; the page's own reload unless a test says otherwise. */
  readonly onReload?: () => void;
  /** Where the notice sits in what holds it. */
  readonly className?: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  /** The first line of what was thrown; `null` while the children render. */
  readonly message: string | null;
  readonly resetKey: unknown;
}

/** The first line of what was thrown, for people to read. */
export function firstLineOf(thrown: unknown): string {
  const text = thrown instanceof Error ? thrown.message : String(thrown);
  return text.split('\n', 1)[0]?.trim() || 'An unknown error';
}

function reloadPage(): void {
  window.location.reload();
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(thrown: unknown): Partial<ErrorBoundaryState> {
    return { message: firstLineOf(thrown) };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { message: null, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;
    const { label, onReload = reloadPage, className } = this.props;
    return (
      <div role="alert" className={cn('rounded-lg border border-line bg-bg-1 p-4 text-ink', className)}>
        <p className="m-0 font-semibold">{`The ${label} could not be shown`}</p>
        <p className="m-0 mt-1 break-words font-mono text-[12.5px] text-ink-2">{message}</p>
        <button
          type="button"
          onClick={onReload}
          className="mt-3 inline-flex min-h-8 cursor-pointer items-center rounded-md border border-line-strong bg-bg-2 px-3 font-semibold text-[12.5px] text-ink hover:bg-bg-0"
        >
          Reload
        </button>
      </div>
    );
  }
}
