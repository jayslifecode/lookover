import type { RunContext } from '../run/run-context.js';
import { ConsoleObserver } from './console.js';
import { RequestObserver } from './requests.js';
import { TextObserver } from './text.js';
import type { Observer } from './types.js';

/** The observers every review runs with unless it is given others: console, requests and rendered text. */
export function defaultObservers(ctx: RunContext): Observer[] {
  return [new ConsoleObserver(ctx), new RequestObserver(ctx), new TextObserver(ctx)];
}
