import { isCancel, multiselect } from '@clack/prompts';
import type { ConfirmHosts } from '@jayslifecode/lookover-core';

/** The host confirmation question, word for word: the answer lets the run send requests to those hosts. */
export const CONFIRM_HOSTS_MESSAGE =
  'These backends were called by the app. Confirm each one is a development or disposable instance';

/** The person cancelled a prompt: the run stops and the CLI exits 1 with "Cancelled.". */
export class RunCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'RunCancelledError';
  }
}

export interface PromptContext {
  readonly isYes: boolean;
  readonly isStdinTTY: boolean;
  readonly isStdoutTTY: boolean;
}

/** Prompts only when someone can answer: a terminal on both ends and no `--yes`. */
export function shouldPrompt(context: PromptContext): boolean {
  return !context.isYes && context.isStdinTTY && context.isStdoutTTY;
}

/**
 * The engine's `confirmHosts` hook. Interactive: a multiselect with every host selected; a cancel
 * throws `RunCancelledError`, which ends the run with the browser closed. Non-interactive: confirms
 * nothing, so the engine refuses with `E_HOSTS_UNCONFIRMED` naming the hosts and the `--confirm-host`
 * command (those hosts would already count as confirmed had they been passed with the flag).
 */
export function createConfirmHosts(isInteractive: boolean): ConfirmHosts {
  if (!isInteractive) {
    return () => Promise.resolve([]);
  }
  return async (hosts) => {
    const answer = await multiselect({
      message: CONFIRM_HOSTS_MESSAGE,
      options: hosts.map((host) => ({ value: host, label: host })),
      initialValues: hosts,
      // Confirming none is an answer: the engine then refuses the run and names the hosts.
      required: false,
    });
    if (isCancel(answer)) {
      throw new RunCancelledError();
    }
    return answer;
  };
}
