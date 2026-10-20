import { describe, expect, test } from 'vitest';
import { LookoverError } from '../src/errors.js';

describe('LookoverError', () => {
  test('carries a stable code and an optional hint', () => {
    const err = new LookoverError('E_ACK_REQUIRED', 'Run refused', 'Run `lookover init`');
    expect(err.code).toBe('E_ACK_REQUIRED');
    expect(err.hint).toBe('Run `lookover init`');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LookoverError');
  });
});
