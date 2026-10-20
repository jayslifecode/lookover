import { LookoverError } from '@jayslifecode/lookover-core';

// All CLI output goes through process.stdout/stderr rather than `console`, so a stray debug
// print can never pass for user-facing output (and Biome's noConsole stays meaningful).

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_INVALID = 2;
export const EXIT_REFUSED = 3;

const CONFIG_ERROR_PREFIX = 'E_CONFIG_';
const REFUSAL_CODES: readonly string[] = ['E_ACK_REQUIRED', 'E_HOSTS_UNCONFIRMED'];

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function success(message: string): void {
  process.stdout.write(`✔ ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`! ${message}\n`);
}

/** Two aligned columns: every value starts at the same offset, whatever the key lengths. */
export function table(rows: readonly (readonly [string, string])[]): void {
  const keyWidth = Math.max(0, ...rows.map(([key]) => key.length));
  for (const [key, value] of rows) {
    process.stdout.write(`  ${key.padEnd(keyWidth)}  ${value}\n`);
  }
}

export function exitCodeFor(error: unknown): number {
  if (!(error instanceof LookoverError)) {
    return EXIT_FAILURE;
  }
  if (error.code.startsWith(CONFIG_ERROR_PREFIX)) {
    return EXIT_INVALID;
  }
  return REFUSAL_CODES.includes(error.code) ? EXIT_REFUSED : EXIT_FAILURE;
}

/** Prints the error for a human and exits with the code that scripts can rely on. */
export function fail(error: unknown): never {
  if (error instanceof LookoverError) {
    process.stderr.write(`✖ ${error.code}: ${error.message}\n`);
    if (error.hint !== undefined) {
      process.stderr.write(`  hint: ${error.hint}\n`);
    }
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`✖ ${message}\n`);
  }
  return process.exit(exitCodeFor(error));
}
