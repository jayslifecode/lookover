import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview } from '@jayslifecode/lookover-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runRun } from '../src/commands/run.js';
import type { RunFlags } from '../src/commands/run-options.js';
import { openInBrowser } from '../src/report/open-browser.js';
import { type ReportServer, startReportServer } from '../src/report/server.js';
import { appMap, findingsFile } from './run-fixtures.js';

// The mocks of this suite: the engine (it opens a real browser), the report server (report-server.test.ts
// covers it) and the browser the report opens in. What is left is how `lookover run` wires them.
vi.mock('@jayslifecode/lookover-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@jayslifecode/lookover-core')>();
  return { ...original, runReview: vi.fn() };
});
vi.mock('../src/report/server.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/report/server.js')>();
  return { ...original, startReportServer: vi.fn() };
});
vi.mock('../src/report/open-browser.js', () => ({ openInBrowser: vi.fn() }));

const VERSION = '9.9.9';
const REPORT_URL = 'http://127.0.0.1:4321/?token=0123456789abcdef0123456789abcdef';

describe('lookover run and its report', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];
  let close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** What happened, in order: the server starting, the engine running, the server closing. */
  let calls: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-report-'));
    await writeFile(
      join(dir, 'lookover.config.json'),
      JSON.stringify({ baseUrl: 'http://localhost:3000', interaction: 'safe', framework: 'unknown' }),
    );
    stdout = [];
    stderr = [];
    calls = [];
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    close = vi.fn(async () => {
      calls.push('close');
    });
    const server: ReportServer = { url: REPORT_URL, port: 4321, token: 'token', close };
    vi.mocked(startReportServer).mockImplementation(async () => {
      calls.push('serve');
      return server;
    });
    vi.mocked(openInBrowser).mockResolvedValue(true);
    vi.mocked(runReview).mockImplementation(async () => {
      calls.push('review');
      return {
        map: appMap([]),
        confirmedBackendHosts: [],
        blockedUnconfirmedHosts: [],
        findings: findingsFile([]),
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(startReportServer).mockReset();
    vi.mocked(openInBrowser).mockReset();
    vi.mocked(runReview).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  function lines(): string[] {
    return stdout.join('').split('\n');
  }

  async function run(flags: RunFlags = {}): Promise<void> {
    await runRun({ yes: true, ...flags }, VERSION);
  }

  test('serves the run before the engine opens the browser, and prints its URL before the mapping line', async () => {
    await run();

    const [options] = vi.mocked(startReportServer).mock.calls[0] ?? [];
    expect(calls.slice(0, 2)).toEqual(['serve', 'review']);
    expect(options).toMatchObject({
      cwd: dir,
      lookoverDir: join(dir, '.lookover'),
      lookoverVersion: VERSION,
      host: '127.0.0.1',
    });
    expect(options?.runId).toMatch(/^\d{8}-\d{6}-[0-9a-z]{4}$/);
    const printed = lines();
    const reportLine = printed.indexOf(`Report: ${REPORT_URL}`);
    expect(reportLine).toBeGreaterThanOrEqual(0);
    expect(printed.findIndex((line) => line.startsWith('Mapping '))).toBe(reportLine + 1);
  });

  test('opens the report in the browser', async () => {
    await run();

    expect(openInBrowser).toHaveBeenCalledWith(REPORT_URL);
  });

  test('adds a Report row with the URL right after the Findings row', async () => {
    await run();

    const printed = lines();
    const findingsRow = printed.findIndex((line) => /^ {2}Findings +/.test(line));
    expect(printed[findingsRow + 1]).toMatch(
      new RegExp(`^ {2}Report +${REPORT_URL.replace(/[?.]/g, '\\$&')}$`),
    );
  });

  test('closes the server once the summary is printed when stdout is not a terminal', async () => {
    await run();

    expect(calls).toEqual(['serve', 'review', 'close']);
    expect(stdout.join('')).not.toContain('press Ctrl-C');
  });

  test('with --no-open serves the report but does not open it', async () => {
    await run({ open: false });

    expect(startReportServer).toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
    expect(lines()).toContain(`Report: ${REPORT_URL}`);
  });

  test('with --no-report serves nothing and prints no Report line or row', async () => {
    await run({ report: false });

    expect(startReportServer).not.toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
    expect(stdout.join('')).not.toMatch(/Report/);
  });

  test('warns, and carries on, when the browser cannot be opened', async () => {
    vi.mocked(openInBrowser).mockResolvedValue(false);

    await run();

    expect(stderr.join('')).toContain('Could not open the report in a browser');
    expect(calls).toEqual(['serve', 'review', 'close']);
  });

  test('closes the server when the run fails, and fails as before', async () => {
    vi.mocked(runReview).mockRejectedValue(new Error('the browser closed'));

    await expect(run()).rejects.toThrow('the browser closed');

    expect(close).toHaveBeenCalled();
  });

  describe('when stdout is a terminal', () => {
    let wasTTY: boolean | undefined;

    beforeEach(() => {
      wasTTY = process.stdout.isTTY;
      process.stdout.isTTY = true;
    });

    afterEach(() => {
      process.stdout.isTTY = wasTTY as boolean;
    });

    test('keeps serving after the summary until Ctrl-C, then closes the server and exits 0', async () => {
      const running = run();
      await expect.poll(() => stdout.join('')).toContain('press Ctrl-C to close');

      expect(close).not.toHaveBeenCalled();
      expect(lines()).toContain(`Report open at ${REPORT_URL}; press Ctrl-C to close`);
      process.emit('SIGINT');
      await running;

      expect(close).toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
    });
  });
});
