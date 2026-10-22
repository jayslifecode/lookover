import type { RunInfo } from '@/data/reduce';
import { Command } from './empty-states';

/*
 * A run that failed (`run.failed`) says so at the top of the main area, on a solid surface: what went
 * wrong, its code, and what to do about it. The event carries the error's code and message, not the hint
 * the terminal printed, so the hint here comes from the code; the views below still show what the run
 * reached before it failed.
 */

type RunError = NonNullable<RunInfo['error']>;

/** What to do about a failure, by its code, before running again; the terminal has the full hint. */
const HINT: Readonly<Record<string, string>> = {
  E_AUTH_FAILED:
    'Check the login settings and credentials in lookover.config.json, and that the app is running',
  E_HOSTS_UNCONFIRMED:
    'Confirm the backends the terminal lists, only if they are development or disposable instances',
  E_NAVIGATION_BLOCKED:
    "Add the base URL's host to allowHosts in lookover.config.json, or pass it with --allow-host",
  E_CONFIG_INVALID: 'Fix the fields the terminal names in lookover.config.json',
  E_CONFIG_NOT_FOUND: 'Run lookover init in your project root',
  E_ACK_REQUIRED: 'Run lookover init and confirm the app\'s data is disposable, or set "interaction": "safe"',
};
const FALLBACK_HINT = 'The terminal that ran it shows the full error: fix what it names';

export function failureHint(code: string): string {
  return Object.hasOwn(HINT, code) ? (HINT[code] ?? FALLBACK_HINT) : FALLBACK_HINT;
}

export function RunFailedNotice({ error }: { readonly error: RunError }) {
  return (
    <div role="alert" className="mb-4 rounded-lg border border-high bg-bg-1 p-4">
      <p className="m-0 flex flex-wrap items-baseline gap-x-2 font-semibold text-ink">
        The run failed
        <code className="font-medium font-mono text-[12px] text-ink-2">{error.code}</code>
      </p>
      <p className="m-0 mt-1 whitespace-pre-line break-words text-ink">{error.message}</p>
      <p className="m-0 mt-2 text-[13px] text-ink-2">
        {failureHint(error.code)}, then run <Command>lookover run</Command> again.
      </p>
    </div>
  );
}
