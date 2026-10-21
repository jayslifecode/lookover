import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONFIG_FILENAME,
  type LookoverConfig,
  LookoverError,
  writeConfig,
} from '@jayslifecode/lookover-core';
import { type Command, Option } from 'commander';
import * as ui from '../ui.js';
import {
  AUTH_ENV,
  buildConfig,
  FRAMEWORKS,
  type Framework,
  INTERACTIONS,
  type InitAnswers,
  type Interaction,
  isHttpUrl,
} from './init-config.js';
import { detectFramework, ensureGitignored, type GitignoreChange } from './init-files.js';
import { promptInitAnswers, showSummary } from './init-prompts.js';

interface InitFlags {
  readonly nonInteractive?: boolean;
  readonly baseUrl?: string;
  readonly root: string;
  readonly interaction?: Interaction;
  readonly acknowledgeDisposableData?: boolean;
  readonly framework?: Framework;
}

const DEFAULT_NON_INTERACTIVE_INTERACTION: Interaction = 'safe';
const BASE_URL_HINT = 'For example: --base-url http://localhost:3000';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(`Create ${CONFIG_FILENAME} for this project`)
    .option('--non-interactive', 'never prompt; requires --base-url')
    .option('--base-url <url>', 'the URL the app runs at, e.g. http://localhost:3000')
    .option('--root <dir>', 'the app directory (where package.json lives), relative to here', '.')
    .addOption(
      choiceOption(
        '--interaction <mode>',
        'full clicks and submits anything; safe never submits forms',
        INTERACTIONS,
      ),
    )
    .option(
      '--acknowledge-disposable-data',
      'confirm that all data the app can reach is disposable (full only)',
    )
    .addOption(choiceOption('--framework <name>', 'override framework auto-detection', FRAMEWORKS))
    .action(runInit);
}

/**
 * An option that takes one of `choices`. Commander lists them in `--help` (`choices`); a value that is
 * not one is rejected by `parseChoice` as an `E_USAGE` error like every other flag problem, not by
 * Commander's own message.
 */
function choiceOption<T extends string>(flags: string, description: string, choices: readonly T[]): Option {
  const [flag = flags] = flags.split(' ');
  return new Option(flags, description)
    .choices(choices)
    .argParser((value) => parseChoice(flag, value, choices));
}

function parseChoice<T extends string>(flag: string, value: string, choices: readonly T[]): T {
  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) {
    throw new LookoverError(
      'E_USAGE',
      `${flag} "${value}" is not one of ${choices.join(', ')}`,
      `Pass one of: ${choices.map((candidate) => `${flag} ${candidate}`).join(', ')}`,
    );
  }
  return choice;
}

export async function runInit(flags: InitFlags): Promise<void> {
  const cwd = process.cwd();
  const detected = await detectFramework(resolve(cwd, flags.root));
  const framework = flags.framework ?? detected;
  if (flags.nonInteractive === true) {
    await initWithFlags(cwd, flags, framework);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new LookoverError(
      'E_USAGE',
      'init needs a terminal to ask its questions',
      'Run `lookover init --non-interactive --base-url <url>` in scripts and CI',
    );
  }
  await initWithPrompts(cwd, flags, framework);
}

async function initWithFlags(cwd: string, flags: InitFlags, framework: Framework): Promise<void> {
  const answers = answersFromFlags(flags, framework);
  // Validated (and, for `full`, gated on the acknowledgement) before anything touches the disk.
  const config = buildConfig(answers, flags.root);
  if (flags.acknowledgeDisposableData === true && config.interaction === 'safe') {
    ui.warn('--acknowledge-disposable-data has no effect without --interaction full');
  }
  if (existsSync(resolve(cwd, CONFIG_FILENAME))) {
    ui.warn(`Replacing the existing ${CONFIG_FILENAME}`);
  }
  const written = await writeProject(cwd, config);
  for (const line of summaryLines(written)) {
    ui.success(line);
  }
  ui.table(nextSteps(config).map((step, index): [string, string] => [`${index + 1}.`, step]));
}

function answersFromFlags(flags: InitFlags, framework: Framework): InitAnswers {
  if (flags.baseUrl === undefined) {
    throw new LookoverError('E_USAGE', '--non-interactive requires --base-url <url>', BASE_URL_HINT);
  }
  const baseUrl = flags.baseUrl.trim();
  if (!isHttpUrl(baseUrl)) {
    throw new LookoverError('E_USAGE', `--base-url "${flags.baseUrl}" is not an http(s) URL`, BASE_URL_HINT);
  }
  return {
    baseUrl,
    framework,
    interaction: flags.interaction ?? DEFAULT_NON_INTERACTIVE_INTERACTION,
    acknowledgedDisposableData: flags.acknowledgeDisposableData === true,
  };
}

async function initWithPrompts(cwd: string, flags: InitFlags, framework: Framework): Promise<void> {
  const answers = await promptInitAnswers({
    ...(flags.baseUrl === undefined ? {} : { baseUrl: flags.baseUrl }),
    framework,
    isFrameworkDetected: flags.framework === undefined && framework !== 'unknown',
    configExists: existsSync(resolve(cwd, CONFIG_FILENAME)),
  });
  if (answers === undefined) {
    return;
  }
  const config = buildConfig(answers, flags.root);
  const written = await writeProject(cwd, config);
  showSummary(summaryLines(written), nextSteps(config));
}

interface WrittenProject {
  readonly gitignore: GitignoreChange;
}

async function writeProject(cwd: string, config: LookoverConfig): Promise<WrittenProject> {
  await writeConfig(cwd, config);
  return { gitignore: await ensureGitignored(cwd) };
}

function summaryLines(written: WrittenProject): string[] {
  const gitignoreLine = {
    created: 'Created .gitignore with .lookover/',
    updated: 'Added .lookover/ to .gitignore',
    unchanged: '.gitignore already ignores .lookover/',
  }[written.gitignore];
  return [`Wrote ${CONFIG_FILENAME}`, gitignoreLine];
}

function nextSteps(config: LookoverConfig): string[] {
  const steps = ['Start your app, then run `lookover run`'];
  if (config.auth.type === 'form') {
    steps.unshift(`Export ${AUTH_ENV.username} and ${AUTH_ENV.password} in your shell`);
  }
  return steps;
}
