/** What the console observer needs of an entry to tell whether it is noise. */
interface NoiseCandidate {
  readonly text: string;
  readonly location: string | null;
}

/** Messages a dev server, a framework or the browser prints about itself; none of them is the app's. */
export const IGNORED_CONSOLE_PATTERNS: readonly RegExp[] = [
  /^\[Fast Refresh\]/,
  /^Download the React DevTools/,
  /^\[HMR\]/,
  /^%cNext\.js/,
  // The browser's own line for every request that failed, logged as an error with the resource as its
  // location: `Failed to load resource: the server responded with a status of 404 (Not Found)`,
  // `Failed to load resource: net::ERR_CONNECTION_REFUSED` and, for a call Lookover blocks,
  // `Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector`. The request observer reports the
  // failures that are the app's, with the method, URL and status; the console would report each twice,
  // and report Lookover's own blocks and the favicon the request observer leaves out as the app's.
  /^Failed to load resource: /,
];

/** Messages logged by a browser extension (a password manager, an ad blocker) come from this origin. */
const EXTENSION_ORIGIN = 'chrome-extension://';

/** True for an entry that is dev tooling chatter or comes from a browser extension, not from the app. */
export function isIgnoredConsoleEntry({ text, location }: NoiseCandidate): boolean {
  if (location?.startsWith(EXTENSION_ORIGIN)) return true;
  return IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(text));
}
