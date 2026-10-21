/** What the console observer needs of an entry to tell whether it is noise. */
interface NoiseCandidate {
  readonly text: string;
  readonly location: string | null;
}

/** Messages a dev server or a framework prints about itself; none of them is the app's. */
export const IGNORED_CONSOLE_PATTERNS: readonly RegExp[] = [
  /^\[Fast Refresh\]/,
  /^Download the React DevTools/,
  /^\[HMR\]/,
  /^%cNext\.js/,
];

/** Messages logged by a browser extension (a password manager, an ad blocker) come from this origin. */
const EXTENSION_ORIGIN = 'chrome-extension://';

/** True for an entry that is dev tooling chatter or comes from a browser extension, not from the app. */
export function isIgnoredConsoleEntry({ text, location }: NoiseCandidate): boolean {
  if (location?.startsWith(EXTENSION_ORIGIN)) return true;
  return IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(text));
}
