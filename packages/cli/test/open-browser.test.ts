import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { browserCommand, openInBrowser } from '../src/report/open-browser.js';

// The one mock of this suite is the spawn: the test must not open a browser on the machine it runs on.
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn() };
});

const URL_WITH_TOKEN = 'http://127.0.0.1:4321/?token=0123456789abcdef0123456789abcdef';

/** A child process that emits `outcome` once it has been handed back, as a real one does. */
function fakeChild(outcome: 'spawn' | Error): ChildProcess & { unref: ReturnType<typeof vi.fn> } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  setImmediate(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', outcome)));
  return child as unknown as ChildProcess & { unref: ReturnType<typeof vi.fn> };
}

describe('browserCommand', () => {
  test.each([
    ['darwin', 'open', [URL_WITH_TOKEN]],
    ['linux', 'xdg-open', [URL_WITH_TOKEN]],
    ['freebsd', 'xdg-open', [URL_WITH_TOKEN]],
    ['win32', 'cmd', ['/c', 'start', '""', URL_WITH_TOKEN]],
  ] as const)('on %s runs %s', (platform, command, args) => {
    expect(browserCommand(platform, URL_WITH_TOKEN)).toEqual({ command, args });
  });

  test('escapes what cmd would read as a command separator on win32', () => {
    expect(browserCommand('win32', 'http://127.0.0.1:1/?a=1&b=2').args.at(-1)).toBe(
      'http://127.0.0.1:1/?a=1^&b=2',
    );
  });
});

describe('openInBrowser', () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  test('spawns the platform command detached, ignoring its output, and lets it outlive the CLI', async () => {
    const child = fakeChild('spawn');
    vi.mocked(spawn).mockReturnValue(child);

    const opened = await openInBrowser(URL_WITH_TOKEN, 'darwin');

    expect(opened).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'open',
      [URL_WITH_TOKEN],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  test('passes the arguments to cmd as written on win32', async () => {
    vi.mocked(spawn).mockReturnValue(fakeChild('spawn'));

    await openInBrowser(URL_WITH_TOKEN, 'win32');

    expect(spawn).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '""', URL_WITH_TOKEN],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  test('resolves false, without throwing, when the command cannot be started', async () => {
    vi.mocked(spawn).mockReturnValue(
      fakeChild(Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })),
    );

    await expect(openInBrowser(URL_WITH_TOKEN, 'linux')).resolves.toBe(false);
  });

  test('resolves false, without throwing, when spawn itself throws', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('EPERM');
    });

    await expect(openInBrowser(URL_WITH_TOKEN, 'linux')).resolves.toBe(false);
  });
});
