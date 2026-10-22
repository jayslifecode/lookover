import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FindingsFile,
  type ReviewOptions,
  type ReviewResult,
  type RunEvent,
  type RunEventBody,
  runReview,
  type Screen,
} from '@jayslifecode/lookover-core';
import { JudgePipeline } from '@jayslifecode/lookover-judge';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runRun } from '../src/commands/run.js';
import type { RunFlags } from '../src/commands/run-options.js';
import { CANDIDATES_NOTE, HARNESS_ONLY_NOTE } from '../src/commands/run-summary.js';
import {
  appMap,
  element,
  findingsFile,
  form,
  HARNESS_ONLY,
  judged,
  judgedFile,
  occurrenceCandidate,
  screen,
  stepCandidate,
} from './run-fixtures.js';

const VERSION = '9.9.9';

// The one mock of this suite is the engine: it opens a real browser, which `run.test.ts` and the
// end-to-end suite cover. Everything else here is the CLI's own code on a real project directory.
vi.mock('@jayslifecode/lookover-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@jayslifecode/lookover-core')>();
  return { ...original, runReview: vi.fn(original.runReview) };
});

interface Script {
  /** What the engine reports while it runs, in order. */
  readonly events: readonly RunEventBody[];
  readonly findings?: FindingsFile;
}

interface Output {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** What `runRun` handed the engine. */
  readonly options: ReviewOptions;
}

function captured(screenOverrides: Partial<Screen>): RunEventBody {
  return { type: 'screen.captured', screen: screen(screenOverrides) };
}

/** `body` as the run log hands it to a subscriber. */
function logged(body: RunEventBody, seq: number, runId: string): RunEvent {
  return { ...body, seq, at: '2026-10-22T00:00:00.000Z', runId } as RunEvent;
}

function inspected(screenId: string, candidates: number, error: string | null = null): RunEventBody {
  return {
    type: 'screen.inspected',
    screenId,
    durationMs: 120,
    candidates,
    worthALook: 0,
    skipped: [],
    gallery: null,
    error,
  };
}

describe('lookover run with the engine stubbed', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-inspection-'));
    await writeFile(
      join(dir, 'lookover.config.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3000', interaction: 'safe', framework: 'unknown' }),
    );
    stdout = [];
    stderr = [];
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    // A developer's key must not change what these tests see; the judge never runs here anyway.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.mocked(runReview).mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs `lookover run` in-process; the engine plays `script` through the hooks and returns its findings. */
  async function run(flags: RunFlags, script: Script): Promise<Output> {
    vi.mocked(runReview).mockImplementation(async (ctx, options) => {
      script.events.forEach((body, index) => {
        options.hooks?.onEvent?.(logged(body, index + 1, ctx.runId));
      });
      const screens = script.events.flatMap((event) =>
        event.type === 'screen.captured' ? [event.screen] : [],
      );
      const result: ReviewResult = {
        map: appMap(screens),
        confirmedBackendHosts: [],
        blockedUnconfirmedHosts: [],
        findings: script.findings ?? findingsFile([]),
      };
      return result;
    });
    await runRun({ yes: true, ...flags }, VERSION);
    const [call] = vi.mocked(runReview).mock.calls;
    if (call === undefined) {
      throw new Error('runReview was not called');
    }
    return { stdout: stdout.join('').split('\n'), stderr: stderr.join('').split('\n'), options: call[1] };
  }

  describe('what the engine is asked to do', () => {
    test('inspects with the interaction lens and the default observers', async () => {
      const { options } = await run({}, { events: [] });

      expect(options.lenses).toHaveLength(1);
      expect(options.lenses?.[0]).toBeInstanceOf(InteractionLens);
      expect(options).not.toHaveProperty('observers');
    });

    test('--lens interaction asks for the same single lens', async () => {
      const { options } = await run({ lens: ['interaction', 'interaction'] }, { events: [] });

      expect(options.lenses).toHaveLength(1);
      expect(options.lenses?.[0]).toBeInstanceOf(InteractionLens);
    });

    test('judges the candidates with a judge pipeline', async () => {
      const { options } = await run({}, { events: [] });

      expect(options.judge).toBeInstanceOf(JudgePipeline);
    });

    test('--no-judge asks for a judge that only applies the decisions, not a pipeline', async () => {
      const { options } = await run({ judge: false }, { events: [] });

      expect(options.judge).toBeDefined();
      expect(options.judge).not.toBeInstanceOf(JudgePipeline);
      expect(options.lenses?.[0]).toBeInstanceOf(InteractionLens);
    });

    test('--map-only asks for no judge either: there is nothing to judge', async () => {
      const { options } = await run({ mapOnly: true }, { events: [] });

      expect(options.judge).toBeUndefined();
    });

    test('--no-report and --no-open change nothing the engine is asked yet', async () => {
      const { options } = await run({ report: false, open: false }, { events: [] });

      expect(options.judge).toBeInstanceOf(JudgePipeline);
      expect(options.lenses).toHaveLength(1);
    });

    test('--map-only asks for no lenses and no observers', async () => {
      const { options } = await run({ mapOnly: true }, { events: [] });

      expect(options.lenses).toEqual([]);
      expect(options.observers).toEqual([]);
    });

    test('--map-only wins over --lens', async () => {
      const { options } = await run({ mapOnly: true, lens: ['interaction'] }, { events: [] });

      expect(options.lenses).toEqual([]);
      expect(options.observers).toEqual([]);
    });
  });

  describe('progress', () => {
    const settings = {
      id: 'settings',
      route: '/settings',
      elements: [element('save')],
      forms: [form('form')],
    };

    test('prints the line of a screen when it has been inspected, with its candidates', async () => {
      const { stdout: lines } = await run({}, { events: [captured(settings), inspected('settings', 2)] });

      expect(lines).toContain('✓ /settings  1 element · 1 form · 2 candidates');
    });

    test('prints nothing for a screen until its inspection is reported', async () => {
      let printedWhenCaptured = '';
      vi.mocked(runReview).mockImplementation(async (ctx, options) => {
        options.hooks?.onEvent?.(logged(captured(settings), 1, ctx.runId));
        printedWhenCaptured = stdout.join('');
        options.hooks?.onEvent?.(logged(inspected('settings', 0), 2, ctx.runId));
        return {
          map: appMap([]),
          confirmedBackendHosts: [],
          blockedUnconfirmedHosts: [],
          findings: findingsFile([]),
        };
      });

      await runRun({ yes: true }, VERSION);

      expect(printedWhenCaptured).not.toContain('/settings');
      expect(stdout.join('')).toContain('✓ /settings  1 element · 1 form · 0 candidates');
    });

    test('when the run fails, prints the screen that was captured but not inspected, without candidates', async () => {
      vi.mocked(runReview).mockImplementation((ctx, options) => {
        const events = [
          captured({ id: 'a', route: '/a' }),
          inspected('a', 1),
          captured({ id: 'b', route: '/b', elements: [element('go')] }),
        ];
        events.forEach((body, index) => {
          options.hooks?.onEvent?.(logged(body, index + 1, ctx.runId));
        });
        return Promise.reject(new Error('the browser closed'));
      });

      await expect(runRun({ yes: true }, VERSION)).rejects.toThrow('the browser closed');

      const lines = stdout.join('').split('\n');
      expect(lines.filter((line) => line.startsWith('✓ /'))).toEqual([
        '✓ /a  0 elements · 0 forms · 1 candidate',
        '✓ /b  1 element · 0 forms',
      ]);
    });

    test('prints one line per screen, in the order the inspections are reported', async () => {
      const { stdout: lines } = await run(
        {},
        {
          events: [
            captured({ id: 'a', route: '/a' }),
            inspected('a', 0),
            captured({ id: 'b', route: '/b' }),
            inspected('b', 5),
          ],
        },
      );

      expect(lines.filter((line) => line.startsWith('✓ /'))).toEqual([
        '✓ /a  0 elements · 0 forms · 0 candidates',
        '✓ /b  0 elements · 0 forms · 5 candidates',
      ]);
    });

    test('follows the line of a screen whose inspection failed with a warning naming the error', async () => {
      const { stdout: lines, stderr: warnings } = await run(
        {},
        { events: [captured(settings), inspected('settings', 1, 'lens exploded')] },
      );

      expect(lines).toContain('✓ /settings  1 element · 1 form · 1 candidate');
      expect(warnings).toContain('! /settings  inspection failed: lens exploded');
    });

    test('prints a screen whose navigation failed at once, with no candidates', async () => {
      const failed = {
        id: 'gone',
        route: '/reports',
        status: 'navigation-failed',
        error: 'net::ERR_ABORTED',
      } as const;
      const { stdout: lines } = await run({}, { events: [captured(failed)] });

      expect(lines).toContain('! /reports  navigation failed');
    });

    test('with --map-only prints the line when the screen is captured, without a candidate count', async () => {
      const { stdout: lines, stderr: warnings } = await run(
        { mapOnly: true },
        { events: [captured(settings), inspected('settings', 0, 'ignored')] },
      );

      expect(lines.filter((line) => line.includes('/settings'))).toEqual(['✓ /settings  1 element · 1 form']);
      expect(warnings.join('\n')).not.toContain('inspection failed');
    });
  });

  /** The position of each row in `lines`, counted from the first. */
  function rowOffsets(lines: readonly string[], keys: readonly string[]): number[] {
    const positions = keys.map((key) => lines.findIndex((line) => line.startsWith(`  ${key} `)));
    expect(positions[0]).toBeGreaterThan(0);
    return positions.map((position) => position - (positions[0] ?? 0));
  }

  /** What `lookover run` printed after the summary table, blank lines left out. */
  function afterTable(lines: readonly string[]): string[] {
    const lastRow = lines.findIndex((line) => /^ {2}Findings {2,}\S/.test(line));
    return lines.slice(lastRow + 1).filter((line) => line !== '');
  }

  describe('summary of a judged run', () => {
    const findings = judgedFile({
      findings: [
        judged(
          stepCandidate({
            ruleId: 'interaction.focus-visible-missing',
            route: '/settings',
            selector: '#save',
          }),
        ),
        judged(
          stepCandidate({ ruleId: 'interaction.focus-visible-missing', route: '/login', selector: '#go' }),
        ),
        judged(occurrenceCandidate('observers.console-error', ['a', 'b'])),
      ],
      rejected: [
        judged(stepCandidate({ ruleId: 'interaction.target-size', route: '/flaky' }), {
          status: 'rejected',
          reproduced: 2,
        }),
      ],
      worthALook: [stepCandidate({ ruleId: 'interaction.hover-state-missing', severity: 'low' })],
    });
    const events = [captured({ id: 'a', route: '/a' }), inspected('a', 4)];

    test('adds the confirmed, rejected, intended, worth-a-look, skipped, judge and findings rows after the duration', async () => {
      const { stdout: lines } = await run({}, { events, findings });

      const keys = [
        'Duration',
        'Confirmed',
        'Rejected',
        'Intended',
        'Worth a look',
        'Skipped',
        'Judge',
        'Findings',
      ];
      expect(rowOffsets(lines, keys)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Confirmed +3$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Rejected +1$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Intended +0$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Worth a look +1$/));
      expect(lines).toContainEqual(
        expect.stringMatching(/^ {2}Judge +harness only \(no ANTHROPIC_API_KEY\)$/),
      );
      expect(lines.join('\n')).not.toMatch(/^ {2}Candidates /m);
    });

    test('lists the confirmed findings by rule with their reproductions, not the rejected ones, then the harness-only note', async () => {
      const { stdout: lines } = await run({}, { events, findings });

      expect(afterTable(lines)).toEqual([
        '  high    interaction.focus-visible-missing  2  /settings button "Save"     reproduced 3/3',
        '  medium  observers.console-error            1  2 occurrences on 2 screens  reproduced 3/3',
        HARNESS_ONLY_NOTE,
      ]);
    });

    test('prints no note under the findings when the judge model reviewed them', async () => {
      const judge = { ...HARNESS_ONLY, model: 'claude-sonnet-5-5', unavailable: null, estimatedUsd: 0 };
      const { stdout: lines } = await run({}, { events, findings: { ...findings, judge } });

      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Judge +claude-sonnet-5-5 · 0 calls/));
      expect(afterTable(lines)).toHaveLength(2);
    });

    test('prints only the note when nothing was confirmed', async () => {
      const { stdout: lines } = await run({}, { events, findings: { ...findings, findings: [] } });

      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Confirmed +0$/));
      expect(afterTable(lines)).toEqual([HARNESS_ONLY_NOTE]);
    });
  });

  describe('summary of a --no-judge run', () => {
    const findings = findingsFile(
      [
        stepCandidate({ ruleId: 'interaction.focus-visible-missing', route: '/settings', selector: '#save' }),
        stepCandidate({ ruleId: 'interaction.focus-visible-missing', route: '/login', selector: '#go' }),
        occurrenceCandidate('observers.console-error', ['a', 'b']),
      ],
      [stepCandidate({ ruleId: 'interaction.hover-state-missing', severity: 'low' })],
    );
    const events = [captured({ id: 'a', route: '/a' }), inspected('a', 3)];

    test('adds the candidates, intended, worth-a-look, skipped, judge and findings rows right after the duration', async () => {
      const { stdout: lines } = await run({ judge: false }, { events, findings });

      const keys = ['Duration', 'Candidates', 'Intended', 'Worth a look', 'Skipped', 'Judge', 'Findings'];
      expect(rowOffsets(lines, keys)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Candidates +3$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Intended +0$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Worth a look +1$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Skipped +none$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Judge +off \(--no-judge\)$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Findings +\.lookover\/findings\.json$/));
    });

    test('lists the candidates by rule after the table, then the note', async () => {
      const { stdout: lines } = await run({ judge: false }, { events, findings });

      expect(afterTable(lines)).toEqual([
        '  high    interaction.focus-visible-missing  2  /settings button "Save"',
        '  medium  observers.console-error            1  2 occurrences on 2 screens',
        CANDIDATES_NOTE,
      ]);
    });

    test('says there are no candidates but still prints the note when nothing was found', async () => {
      const { stdout: lines } = await run({ judge: false }, { events });

      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Candidates {2,}0$/));
      expect(lines).toContain(CANDIDATES_NOTE);
    });

    test('leaves out a finding marked intended: it is counted as intended, not listed as a candidate', async () => {
      const [decided] = findings.findings;
      if (decided === undefined) throw new Error('the fixture has no finding');
      const decision = { status: 'intended', at: '2026-10-22T00:00:00.000Z', note: null };
      await mkdir(join(dir, '.lookover'), { recursive: true });
      await writeFile(
        join(dir, '.lookover', 'decisions.json'),
        JSON.stringify({ version: 1, decisions: { [decided.id]: decision } }),
      );
      // The engine hands the screen's candidates to the judge and writes the file it drains to.
      vi.mocked(runReview).mockImplementation(async (_ctx, options) => {
        options.judge?.onScreenInspected(screen({ id: 'a', route: '/a' }), findings.findings, []);
        const drained = (await options.judge?.drain(findings))?.file ?? findings;
        return { map: appMap([]), confirmedBackendHosts: [], blockedUnconfirmedHosts: [], findings: drained };
      });

      await runRun({ yes: true, judge: false }, VERSION);

      const lines = stdout.join('').split('\n');
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Candidates +2$/));
      expect(lines).toContainEqual(expect.stringMatching(/^ {2}Intended +1$/));
      expect(afterTable(lines)).toEqual([
        '  high    interaction.focus-visible-missing  1  /login button "Save"',
        '  medium  observers.console-error            1  2 occurrences on 2 screens',
        CANDIDATES_NOTE,
      ]);
    });

    test('with --map-only leaves out the candidates, the worth-a-look entries, the findings and the note', async () => {
      const { stdout: lines } = await run({ mapOnly: true }, { events, findings });

      const text = lines.join('\n');
      expect(text).toMatch(/^ {2}Screens +1$/m);
      expect(text).not.toMatch(
        /Candidates|Confirmed|Worth a look|Skipped|Judge|Findings|interaction\.focus-visible-missing/,
      );
      expect(text).not.toContain(CANDIDATES_NOTE);
    });
  });
});
