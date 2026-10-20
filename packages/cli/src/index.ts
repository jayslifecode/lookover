#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerRun } from './commands/run.js';
import { EXIT_INVALID, EXIT_OK, fail } from './ui.js';

function readVersion(): string {
  const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

const program = new Command()
  .name('lookover')
  .description('Design-and-QA review of a web app, driven in a real browser.')
  .version(readVersion())
  // Commander exits 1 on a bad flag; here a bad flag is a usage error (2), while --help and
  // --version stay 0. Set before the subcommands are registered so they inherit it.
  .exitOverride((error) => process.exit(error.exitCode === 0 ? EXIT_OK : EXIT_INVALID));

registerInit(program);
registerRun(program);

process.on('unhandledRejection', fail);
program.parseAsync(process.argv).catch(fail);
