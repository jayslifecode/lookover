import { checkStorageState } from '../browser/auth.js';
import { BrowserSession, type SessionOptions } from '../browser/session.js';
import { CONFIG_FILENAME } from '../config/load.js';
import { LookoverError } from '../errors.js';
import { firstLine, messageOf } from './session-recorder.js';

/** How Playwright names a storage state it cannot read or will not accept. */
const STORAGE_STATE_ERROR = /storage ?state/i;

/**
 * Launches the session. A storage state is checked first, so a missing or malformed file fails as the
 * auth problem it is (`E_AUTH_FAILED` naming the file) rather than as a browser error; so does a file the
 * browser still rejects, such as one holding a cookie it cannot use.
 */
export async function launchSession(options: SessionOptions): Promise<BrowserSession> {
  const statePath = options.storageStatePath;
  if (statePath !== undefined) {
    await checkStorageState(statePath);
  }
  try {
    return await BrowserSession.launch(options);
  } catch (error) {
    if (statePath === undefined || !STORAGE_STATE_ERROR.test(messageOf(error))) {
      throw error;
    }
    throw new LookoverError(
      'E_AUTH_FAILED',
      `The browser rejected the storage state file ${statePath}: ${firstLine(error)}`,
      `Save the storage state again with Playwright, or point auth.path in ${CONFIG_FILENAME} at another file`,
    );
  }
}

/** Runs `use`, then closes the session. When `use` failed, its error is the one surfaced. */
export async function usingSession<T>(session: BrowserSession, use: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await use();
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
  await session.close();
  return result;
}
