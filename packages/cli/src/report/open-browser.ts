import { spawn } from 'node:child_process';

/** The program that opens a URL in the user's browser, and its arguments. */
export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** What cmd.exe reads as a command separator or a redirection, even inside a URL: escaped with `^`. */
const CMD_METACHARACTERS = /[\^&|<>]/g;

/**
 * How `platform` opens `url`: `open` on macOS, `start` through cmd on Windows (its first quoted argument
 * is the window title, so an empty one comes first), and `xdg-open` everywhere else.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '""', url.replace(CMD_METACHARACTERS, '^$&')] };
  }
  return { command: 'xdg-open', args: [url] };
}

/**
 * Opens `url` in the user's browser: the platform's command, detached and with its output ignored, so it
 * outlives the CLI and prints nothing. Resolves `true` once the command has started and `false` when it
 * could not be (no such program, no permission); it never throws, since the URL is printed anyway.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const { command, args } = browserCommand(platform, url);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        // cmd parses its own command line: Node's quoting of `""` would reach `start` as a title of `\"\"`.
        windowsVerbatimArguments: platform === 'win32',
      });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      // spawn throws synchronously on an invalid argument or a refused permission: the same as not opening.
      resolve(false);
    }
  });
}
