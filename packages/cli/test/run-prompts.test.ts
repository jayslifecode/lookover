import { multiselect } from '@clack/prompts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CONFIRM_HOSTS_MESSAGE,
  createConfirmHosts,
  RunCancelledError,
  shouldPrompt,
} from '../src/commands/run-prompts.js';

// The prompt itself is clack's; these tests drive the answer it gives back.
const { CANCELLED } = vi.hoisted(() => ({ CANCELLED: Symbol('cancelled') }));
vi.mock('@clack/prompts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...original,
    multiselect: vi.fn(),
    isCancel: (value: unknown): value is symbol => value === CANCELLED,
  };
});

const HOSTS = ['api.dev.example.com', 'cdn.example.com', 'xyz.supabase.co'];

function promptOptions(): Parameters<typeof multiselect>[0] {
  const [options] = vi.mocked(multiselect).mock.calls[0] ?? [];
  if (options === undefined) {
    throw new Error('expected the multiselect to be shown');
  }
  return options;
}

describe('host confirmation', () => {
  afterEach(() => {
    vi.mocked(multiselect).mockReset();
  });

  test('the question is worded exactly', () => {
    expect(CONFIRM_HOSTS_MESSAGE).toBe(
      'These backends were called by the app. Confirm each one is a development or disposable instance',
    );
  });

  test('prompts only with a terminal on both ends and without --yes', () => {
    expect(shouldPrompt({ isYes: false, isStdinTTY: true, isStdoutTTY: true })).toBe(true);
    expect(shouldPrompt({ isYes: true, isStdinTTY: true, isStdoutTTY: true })).toBe(false);
    expect(shouldPrompt({ isYes: false, isStdinTTY: false, isStdoutTTY: true })).toBe(false);
    expect(shouldPrompt({ isYes: false, isStdinTTY: true, isStdoutTTY: false })).toBe(false);
  });

  test('without a prompt no host is confirmed, so the engine refuses the run', async () => {
    const confirmHosts = createConfirmHosts(false);

    await expect(confirmHosts(['api.dev.example.com'])).resolves.toEqual([]);
    expect(multiselect).not.toHaveBeenCalled();
  });

  describe('with a prompt', () => {
    test('lists every host with none selected, so Enter alone confirms nothing', async () => {
      vi.mocked(multiselect).mockResolvedValueOnce([]);

      const confirmed = await createConfirmHosts(true)(HOSTS);

      expect(confirmed).toEqual([]);
      expect(promptOptions()).toMatchObject({
        message: CONFIRM_HOSTS_MESSAGE,
        initialValues: [],
        required: false,
        options: HOSTS.map((host) => ({ value: host, label: host })),
      });
    });

    test('returns the hosts the person selected', async () => {
      vi.mocked(multiselect).mockResolvedValueOnce(['api.dev.example.com', 'xyz.supabase.co']);

      const confirmed = await createConfirmHosts(true)(HOSTS);

      expect(confirmed).toEqual(['api.dev.example.com', 'xyz.supabase.co']);
    });

    test('shows each host as the label function shows it, keeping the bare host as the value', async () => {
      vi.mocked(multiselect).mockResolvedValueOnce([]);
      const labelHost = (host: string): string => (host.startsWith('cdn.') ? `${host} (static)` : host);

      await createConfirmHosts(true, labelHost)(HOSTS);

      expect(promptOptions().options).toEqual([
        { value: 'api.dev.example.com', label: 'api.dev.example.com' },
        { value: 'cdn.example.com', label: 'cdn.example.com (static)' },
        { value: 'xyz.supabase.co', label: 'xyz.supabase.co' },
      ]);
    });

    test('throws RunCancelledError when the person cancels', async () => {
      // clack's own cancel symbol is internal; the mocked isCancel recognises this one instead.
      vi.mocked(multiselect).mockResolvedValueOnce(CANCELLED as Awaited<ReturnType<typeof multiselect>>);

      const asking = createConfirmHosts(true)(HOSTS);

      await expect(asking).rejects.toBeInstanceOf(RunCancelledError);
      await expect(asking).rejects.toThrow('Cancelled.');
    });
  });
});
