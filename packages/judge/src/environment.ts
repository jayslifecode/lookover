import { release } from 'node:os';
import type { BrowserSession, Environment, Viewport } from '@jayslifecode/lookover-core';

/** Where a finding was judged: the session's browser, this machine's OS and Node, Lookover and the viewport. */
export function captureEnvironment(
  session: BrowserSession,
  viewport: Viewport,
  lookoverVersion: string,
): Environment {
  return {
    browser: session.browserVersion(),
    os: `${process.platform} ${release()} ${process.arch}`,
    node: process.version,
    lookover: lookoverVersion,
    viewport: { ...viewport },
  };
}
