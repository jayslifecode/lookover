import { styleText } from 'node:util';
import {
  type CANCEL_SYMBOL,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  text,
} from '@clack/prompts';
import { EXIT_FAILURE } from '../ui.js';
import {
  AUTH_ENV,
  type FormLogin,
  FRAMEWORKS,
  type Framework,
  type InitAnswers,
  isHttpUrl,
} from './init-config.js';

/** The disposable-data question, word for word: this is the switch that unlocks full interaction. */
export const ACKNOWLEDGEMENT_LINES = [
  'Lookover will click anything and submit any form in this app, including actions that delete or change data.',
  'Is every piece of data this app can reach disposable — a local or development database you can recreate?',
] as const;

const FRAMEWORK_LABELS: Record<Framework, string> = {
  next: 'Next.js',
  'vite-react': 'Vite + React',
  unknown: 'Something else',
};
const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_LOGIN_PATH = '/login';
const SAFE_MODE_NOTE =
  'Safe mode never submits forms. Run `lookover init` again to switch to full interaction.';

export interface PromptDefaults {
  readonly baseUrl?: string;
  /** From `--framework` or auto-detection; pre-selects the framework question. */
  readonly framework: Framework;
  readonly isFrameworkDetected: boolean;
  readonly configExists: boolean;
}

function unwrap<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value)) {
    cancel('Cancelled.');
    process.exit(EXIT_FAILURE);
  }
  return value;
}

function required(label: string): (value: string | undefined) => string | undefined {
  return (value) => (value?.trim() ? undefined : `${label} is required`);
}

async function askText(
  message: string,
  validate: (value: string | undefined) => string | undefined,
  initialValue?: string,
  placeholder?: string,
): Promise<string> {
  const answer = unwrap(
    await text({
      message,
      validate,
      ...(initialValue === undefined ? {} : { initialValue }),
      ...(placeholder === undefined ? {} : { placeholder }),
    }),
  );
  return answer.trim();
}

function askBaseUrl(initialValue: string): Promise<string> {
  return askText(
    'What URL does your app run at?',
    (value) =>
      isHttpUrl(value?.trim() ?? '') ? undefined : 'Enter an http(s) URL, e.g. http://localhost:3000',
    initialValue,
  );
}

async function askFramework(defaults: PromptDefaults): Promise<Framework> {
  const options = FRAMEWORKS.map((value) => ({
    value,
    label: FRAMEWORK_LABELS[value],
    ...(defaults.isFrameworkDetected && value === defaults.framework ? { hint: 'detected' } : {}),
  }));
  return unwrap(
    await select({ message: 'Which framework is it?', options, initialValue: defaults.framework }),
  );
}

/** Defaults to No: pressing Enter must never unlock full interaction. */
async function askAcknowledgement(): Promise<boolean> {
  const [warning, question] = ACKNOWLEDGEMENT_LINES;
  const answer = unwrap(
    await confirm({
      message: `${styleText('bold', warning)}\n${question}`,
      active: 'Yes',
      inactive: 'No',
      initialValue: false,
    }),
  );
  if (!answer) {
    log.info(SAFE_MODE_NOTE);
  }
  return answer;
}

async function askLogin(): Promise<FormLogin> {
  const loginUrl = await askText(
    'Login page (a path on your app, or a full URL)',
    required('Login page'),
    DEFAULT_LOGIN_PATH,
  );
  const usernameSelector = await askText(
    'CSS selector of the username field',
    required('Selector'),
    undefined,
    'input[name="email"]',
  );
  const passwordSelector = await askText(
    'CSS selector of the password field',
    required('Selector'),
    undefined,
    'input[type="password"]',
  );
  const submitSelector = await askText(
    'CSS selector of the submit button',
    required('Selector'),
    undefined,
    'button[type="submit"]',
  );
  const successUrl = await askText(
    'Where does a successful login land? (path; * allowed)',
    required('Success URL'),
    undefined,
    '/dashboard',
  );
  log.info(
    `Credentials are never stored. Lookover reads them from the ${AUTH_ENV.username} and ${AUTH_ENV.password} environment variables.`,
  );
  return { loginUrl, usernameSelector, passwordSelector, submitSelector, successUrl };
}

/** Walks the person through the questions; resolves to undefined when they keep an existing config. */
export async function promptInitAnswers(defaults: PromptDefaults): Promise<InitAnswers | undefined> {
  intro('lookover init');
  if (defaults.configExists) {
    const overwrite = unwrap(
      await confirm({ message: 'lookover.config.json already exists. Replace it?', initialValue: false }),
    );
    if (!overwrite) {
      outro('Left lookover.config.json unchanged.');
      return undefined;
    }
  }
  const baseUrl = await askBaseUrl(defaults.baseUrl ?? DEFAULT_BASE_URL);
  const framework = await askFramework(defaults);
  const acknowledgedDisposableData = await askAcknowledgement();
  const needsLogin = unwrap(await confirm({ message: 'Does the app need a login?', initialValue: false }));
  const login = needsLogin ? await askLogin() : undefined;
  return {
    baseUrl,
    framework,
    interaction: acknowledgedDisposableData ? 'full' : 'safe',
    acknowledgedDisposableData,
    ...(login === undefined ? {} : { login }),
  };
}

export function showSummary(lines: readonly string[], nextSteps: readonly string[]): void {
  note([...lines, '', ...nextSteps].join('\n'), 'Done');
  outro('Happy reviewing.');
}
