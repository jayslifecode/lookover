import type { InstrumentedPage } from '../browser/session.js';
import { LookoverError } from '../errors.js';
import { mergeFindings } from '../findings/id.js';
import type { Lens, LensContext, LensResult, LensSkip } from '../findings/lens.js';
import type { Finding, FindingsFile } from '../findings/types.js';
import { describeError } from '../map/navigation.js';
import type { Screen, Viewport } from '../map/types.js';
import type { Observer, ObserverResult } from '../observers/types.js';
import type { RunContext } from './run-context.js';

/** How long each lens may spend on a screen: the deadline it is handed is this far ahead of its start. */
export const PER_SCREEN_BUDGET_MS = 10_000;

export interface InspectionOptions {
  lenses: readonly Lens[];
  observers: readonly Observer[];
  /** `config.viewports`; screens are captured at the first, which is restored after each lens. */
  viewports: readonly Viewport[];
  interaction: 'full' | 'safe';
}

/** What one screen yielded, up to the error that stopped its inspection, if one did. */
interface ScreenYield {
  findings: readonly Finding[];
  worthALook: readonly Finding[];
  skipped: readonly LensSkip[];
  error: string | null;
}

const NOTHING_YIELDED: ScreenYield = { findings: [], worthALook: [], skipped: [], error: null };

/**
 * The per-screen inspection inside the crawl, and the run's merged findings. For each captured screen:
 * every observer's `collect` first, before any lens reloads or resizes the page, then each lens in order,
 * each with its own deadline `PER_SCREEN_BUDGET_MS` ahead and the capture viewport restored after it
 * whatever it did. The screen's findings are then merged into the run's (see `mergeFindings`): each
 * candidate id seen for the first time is logged as `finding.candidate`, carrying the finding as merged
 * so far; worth-a-look entries are kept apart and not logged. Last comes `screen.inspected`.
 *
 * A `LookoverError` from an observer or a lens is the run's failure and propagates. Any other error stops
 * that screen's inspection: what the screen yielded before it is kept, the first line of its message is
 * `screen.inspected.error`, and the crawl goes on. Errors from the run log propagate.
 */
export class Inspection {
  private readonly captureViewport: Viewport;
  private findings: readonly Finding[] = [];
  private worthALook: readonly Finding[] = [];

  constructor(
    private readonly ctx: RunContext,
    private readonly options: InspectionOptions,
  ) {
    const [first] = options.viewports;
    if (first === undefined) {
      throw new LookoverError(
        'E_CONFIG_INVALID',
        'No viewports are configured, so there is no capture viewport to inspect screens at',
      );
    }
    this.captureViewport = first;
  }

  /** Hands the crawl page to every observer, before its first navigation. */
  attach(ipage: InstrumentedPage): void {
    for (const observer of this.options.observers) {
      observer.attach(ipage);
    }
  }

  async inspect(screen: Screen, ipage: InstrumentedPage): Promise<void> {
    const startedAt = performance.now();
    const yielded = await this.yieldOf(screen, ipage);
    const findings = mergeFindings(yielded.findings);
    const worthALook = mergeFindings(yielded.worthALook);
    await this.add(findings, worthALook);
    await this.ctx.log.append({
      type: 'screen.inspected',
      screenId: screen.id,
      durationMs: Math.round(performance.now() - startedAt),
      candidates: findings.length,
      worthALook: worthALook.length,
      skipped: [...yielded.skipped],
      error: yielded.error,
    });
  }

  /** The run's merged candidates and worth-a-look entries so far, each in the order first seen. */
  file(): FindingsFile {
    return {
      version: 1,
      runId: this.ctx.runId,
      createdAt: new Date().toISOString(),
      findings: [...this.findings],
      worthALook: [...this.worthALook],
    };
  }

  private async yieldOf(screen: Screen, ipage: InstrumentedPage): Promise<ScreenYield> {
    let yielded = NOTHING_YIELDED;
    try {
      for (const observer of this.options.observers) {
        yielded = including(yielded, await observer.collect(screen));
      }
      for (const lens of this.options.lenses) {
        yielded = including(yielded, await this.runLens(lens, screen, ipage));
      }
      return yielded;
    } catch (error) {
      if (error instanceof LookoverError) {
        throw error;
      }
      return { ...yielded, error: describeError(error) };
    }
  }

  private async runLens(lens: Lens, screen: Screen, ipage: InstrumentedPage): Promise<LensResult> {
    const context: LensContext = {
      ctx: this.ctx,
      screen,
      ipage,
      viewports: this.options.viewports,
      interaction: this.options.interaction,
      deadline: performance.now() + PER_SCREEN_BUDGET_MS,
    };
    let result: LensResult;
    try {
      result = await lens.inspect(context);
    } catch (error) {
      // The lens's error is the one worth reporting. A page that cannot even be resized is closed or
      // has crashed, which the crawl's next navigation reports.
      await this.restoreViewport(ipage).catch(() => undefined);
      throw error;
    }
    await this.restoreViewport(ipage);
    return result;
  }

  private restoreViewport(ipage: InstrumentedPage): Promise<void> {
    const { width, height } = this.captureViewport;
    return ipage.page.setViewportSize({ width, height });
  }

  /** Merges a screen's findings into the run's and logs each candidate id seen for the first time. */
  private async add(findings: readonly Finding[], worthALook: readonly Finding[]): Promise<void> {
    const known = new Set(this.findings.map((finding) => finding.id));
    this.findings = mergeFindings([...this.findings, ...findings]);
    this.worthALook = mergeFindings([...this.worthALook, ...worthALook]);
    for (const finding of this.findings.filter((merged) => !known.has(merged.id))) {
      await this.ctx.log.append({ type: 'finding.candidate', finding });
    }
  }
}

/** What an observer or a lens reported; only lenses skip anything. */
type Reported = Pick<ObserverResult, 'findings' | 'worthALook'> & { skipped?: readonly LensSkip[] };

function including(yielded: ScreenYield, result: Reported): ScreenYield {
  return {
    ...yielded,
    findings: [...yielded.findings, ...result.findings],
    worthALook: [...yielded.worthALook, ...result.worthALook],
    skipped: [...yielded.skipped, ...(result.skipped ?? [])],
  };
}
