import { LookoverError } from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import { errorLines } from '../src/ui.js';

describe('errorLines', () => {
  test('prints the code, the message and the hint of a LookoverError', () => {
    const error = new LookoverError(
      'E_AUTH_FAILED',
      'Login did not leave the login page',
      'Check the selectors',
    );

    expect(errorLines(error)).toEqual([
      '✖ E_AUTH_FAILED: Login did not leave the login page',
      '  hint: Check the selectors',
    ]);
  });

  test('redacts the message and the hint before they are printed', () => {
    const error = new LookoverError(
      'E_RUN_FAILED',
      'Could not load http://localhost:3000/reset?token=abc123 for jay@example.com',
      'Ask jay@example.com, or pass Bearer abcdefgh12345678',
    );

    const printed = errorLines(error).join('\n');

    expect(printed).not.toContain('abc123');
    expect(printed).not.toContain('jay@example.com');
    expect(printed).not.toContain('abcdefgh12345678');
    expect(printed).toContain('token=[redacted]');
    expect(printed).toContain('[email]');
  });

  test('redacts the message of any other error', () => {
    expect(errorLines(new Error('net::ERR_FAILED at mailto:jay@example.com'))).toEqual([
      '✖ net::ERR_FAILED at mailto:[email]',
    ]);
    expect(errorLines('password=hunter2')).toEqual(['✖ password=[redacted]']);
  });
});
