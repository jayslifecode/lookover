import { networkHost } from '../browser/network-policy.js';
import type { SessionEvent } from '../browser/session.js';
import { type ErrorCode, LookoverError } from '../errors.js';
import { confirmHostCommand, EDIT_CONFIG_ALTERNATIVE } from './backend-probe.js';
import type { RunLog } from './run-log.js';

const RUN_LOG_HINT = 'Check that the .lookover directory is writable and its disk has room';

/**
 * Takes the session's events: writes each to the run log and notes the hosts blocked as unconfirmed
 * backends. The events come from browser callbacks, which cannot wait for a write, so each write is
 * queued; the log writes in call order, so the last write settles after every earlier one.
 */
export class SessionRecorder {
  private written: Promise<void> = Promise.resolve();
  private writeFailures: readonly unknown[] = [];
  private blockedHosts: ReadonlySet<string> = new Set();

  constructor(private readonly log: RunLog) {}

  readonly record = (event: SessionEvent): void => {
    this.noteBlockedBackend(event);
    this.written = this.log.append(event).then(
      () => undefined,
      (error: unknown) => {
        this.writeFailures = [...this.writeFailures, error];
      },
    );
  };

  blockedUnconfirmedHosts(): string[] {
    return [...this.blockedHosts].toSorted();
  }

  /** Waits for every write queued so far, failed or not. */
  settled(): Promise<void> {
    return this.written;
  }

  /** Waits for every queued write and returns the ones that failed. */
  async failedWrites(): Promise<readonly unknown[]> {
    await this.settled();
    return this.writeFailures;
  }

  /** Waits for every queued write; throws `E_RUN_FAILED` if one failed. */
  async assertComplete(): Promise<void> {
    const failed = await this.failedWrites();
    if (failed.length > 0) {
      throw new RunLogWriteError(failed);
    }
  }

  private noteBlockedBackend(event: SessionEvent): void {
    if (event.type !== 'request.blocked' || event.reason !== 'unconfirmed-backend') {
      return;
    }
    const url = URL.parse(event.url);
    const host = url === null ? null : networkHost(url);
    if (host !== null) {
      this.blockedHosts = new Set([...this.blockedHosts, host]);
    }
  }
}

/** The run log lost an event although the run itself succeeded, so the run has no complete record. */
export class RunLogWriteError extends LookoverError {
  constructor(failedWrites: readonly unknown[]) {
    super('E_RUN_FAILED', `Run log write failed: ${firstLine(failedWrites[0])}`, RUN_LOG_HINT);
  }
}

/**
 * Logs `run.failed` and returns the error to throw: the run's own error, with the blocked unconfirmed
 * backends added to the hint of an auth failure and the run log's failed writes (this one included,
 * if it fails) added to the message. Either addition builds a new error; the original is not changed.
 */
export async function recordFailure(
  log: RunLog,
  recorder: SessionRecorder,
  error: unknown,
): Promise<unknown> {
  const runError = withBlockedBackends(error, recorder.blockedUnconfirmedHosts());
  const failedWrites = await recorder.failedWrites();
  const failure = withFailedWrites(runError, failedWrites);
  try {
    await log.append({ type: 'run.failed', error: { code: codeOf(failure), message: messageOf(failure) } });
    return failure;
  } catch (appendError) {
    return withFailedWrites(runError, [...failedWrites, appendError]);
  }
}

/** A login may have failed because a backend it needed was blocked: the hint names those backends. */
function withBlockedBackends(error: unknown, hosts: readonly string[]): unknown {
  if (hosts.length === 0 || !(error instanceof LookoverError) || error.code !== 'E_AUTH_FAILED') {
    return error;
  }
  const note =
    `Blocked unconfirmed backends: ${hosts.join(', ')}. If they are development or disposable instances, ` +
    `re-run with: ${confirmHostCommand(hosts)} ${EDIT_CONFIG_ALTERNATIVE}`;
  return new LookoverError(
    error.code,
    error.message,
    error.hint === undefined ? note : `${error.hint}\n${note}`,
  );
}

/** The run's error with the failed log writes added to its message; a run log error already says so. */
function withFailedWrites(error: unknown, failedWrites: readonly unknown[]): unknown {
  if (failedWrites.length === 0 || error instanceof RunLogWriteError) {
    return error;
  }
  const count = failedWrites.length;
  const writes = count === 1 ? 'write' : 'writes';
  return new LookoverError(
    codeOf(error),
    `${messageOf(error)}; additionally, ${count} run-log ${writes} failed: ${firstLine(failedWrites[0])}`,
    hintOf(error),
  );
}

export function codeOf(error: unknown): ErrorCode {
  return error instanceof LookoverError ? error.code : 'E_RUN_FAILED';
}

function hintOf(error: unknown): string | undefined {
  return error instanceof LookoverError ? error.hint : undefined;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Playwright appends a multi-line call log to its messages. */
export function firstLine(error: unknown): string {
  return messageOf(error).split('\n', 1)[0]?.trim() ?? '';
}
