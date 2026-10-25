import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LookoverError } from '@jayslifecode/lookover-core';
import type { RunManifest } from '@jayslifecode/lookover-report/api';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runReportCommand } from '../src/commands/report.js';
import { openInBrowser } from '../src/report/open-browser.js';
import { createFixtureProject, FIXTURE_RUN_ID, PREVIOUS_RUN_ID } from './report-fixture.js';
import { runCli } from './run-cli.js';

// The one mock of this suite is the browser: the served report is fetched instead of opened.
vi.mock('../src/report/open-browser.js', () => ({ openInBrowser: vi.fn(async () => true) }));

const VERSION = '9.9.9';
const CONFIG = JSON.stringify({
  baseUrl: 'http://localhost:3123',
  interaction: 'safe',
  framework: 'unknown',
});
const REPORT_LINE = /^Report: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32})$/m;

async function rejection(promise: Promise<unknown>): Promise<LookoverError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof LookoverError)) throw new Error(`Expected a LookoverError, got ${String(error)}`);
  return error;
}

describe('lookover report', () => {
  let dir: string;
  let stdout: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-report-command-'));
    await writeFile(join(dir, 'lookover.config.json'), CONFIG);
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(openInBrowser).mockClear();
    await rm(dir, { recursive: true, force: true });
  });

  describe('fails before serving anything', () => {
    test('with E_RUN_FAILED when the project has no run', async () => {
      const error = await rejection(runReportCommand({}, VERSION, dir));

      expect(error.code).toBe('E_RUN_FAILED');
      expect(error.hint).toContain('lookover run');
    });

    test('with E_RUN_FAILED when no run has written its findings', async () => {
      await mkdir(join(dir, '.lookover', 'runs', '20261022-101500-a1b2'), { recursive: true });

      const error = await rejection(runReportCommand({}, VERSION, dir));

      expect(error.code).toBe('E_RUN_FAILED');
    });

    test.each(['20261022-101500-a1b2', '../outside', ''])(
      'with E_USAGE for --run "%s", no such run',
      async (run) => {
        const error = await rejection(runReportCommand({ run }, VERSION, dir));

        expect(error.code).toBe('E_USAGE');
        expect(error.message).toContain('--run');
      },
    );

    test.each(['abc', '-1', '65536', '1.5'])('with E_USAGE for --port %s', async (port) => {
      const error = await rejection(runReportCommand({ port }, VERSION, dir));

      expect(error.code).toBe('E_USAGE');
      expect(error.message).toContain('--port');
      expect(error.hint).toContain('from 0 to 65535');
    });

    test('says in its help that it serves the latest finished run unless --run names one', async () => {
      const help = (await runCli(dir, ['report', '--help'])).stdout.replace(/\s+/g, ' ');

      expect(help).toContain('the latest finished run');
      expect(help).toContain('0 picks a free one');
    });

    test('exits 1 from the command line when there is no run, and 2 for an unknown --run', async () => {
      const none = await runCli(dir, ['report', '--no-open']);
      const unknown = await runCli(dir, ['report', '--run', 'nope', '--no-open']);

      expect(none.code).toBe(1);
      expect(none.stderr).toContain('E_RUN_FAILED');
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain('E_USAGE');
    });
  });

  describe('serving a run', () => {
    let projectDir: string;

    beforeEach(async () => {
      const project = await createFixtureProject('lookover-report-command-run-');
      projectDir = project.dir;
      await writeFile(join(projectDir, 'lookover.config.json'), CONFIG);
    });

    afterEach(async () => {
      await rm(projectDir, { recursive: true, force: true });
    });

    /** Starts the command, waits for its URL, and answers the manifest it serves; then sends Ctrl-C. */
    async function serve(
      flags: Parameters<typeof runReportCommand>[0],
    ): Promise<{ manifest: RunManifest; url: string }> {
      const command = runReportCommand(flags, VERSION, projectDir);
      await expect.poll(() => REPORT_LINE.test(stdout.join(''))).toBe(true);
      const url = REPORT_LINE.exec(stdout.join(''))?.[1] ?? '';
      const token = new URL(url).searchParams.get('token') ?? '';
      const response = await fetch(new URL('/api/run', url), { headers: { 'x-lookover-token': token } });
      const manifest = (await response.json()) as RunManifest;
      process.emit('SIGINT');
      await command;
      await expect(fetch(url)).rejects.toThrow();
      return { manifest, url };
    }

    test('serves the latest run that wrote its findings, opens it, and closes on Ctrl-C', async () => {
      const { manifest, url } = await serve({});

      expect(manifest.runId).toBe(FIXTURE_RUN_ID);
      expect(openInBrowser).toHaveBeenCalledWith(url);
      expect(stdout.join('')).toContain('Ctrl-C to close');
    });

    test('serves the run --run names on --port 0 (a free port), without opening it with --no-open', async () => {
      const { manifest } = await serve({ run: PREVIOUS_RUN_ID, open: false, port: '0' });

      expect(manifest.runId).toBe(PREVIOUS_RUN_ID);
      expect(openInBrowser).not.toHaveBeenCalled();
    });
  });
});
