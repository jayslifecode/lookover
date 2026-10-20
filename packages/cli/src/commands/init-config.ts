import { userInfo } from 'node:os';
import { configSchema, type LookoverConfig, LookoverError } from '@jayslifecode/lookover-core';

export type Framework = LookoverConfig['framework'];
export type Interaction = LookoverConfig['interaction'];

export const FRAMEWORKS: readonly Framework[] = ['next', 'vite-react', 'unknown'];
export const INTERACTIONS: readonly Interaction[] = ['full', 'safe'];

/** The environment variables a form login reads; the config stores these names, never the values. */
export const AUTH_ENV = { username: 'LOOKOVER_USERNAME', password: 'LOOKOVER_PASSWORD' } as const;

const ACK_HINT =
  'Pass --acknowledge-disposable-data if every piece of data the app can reach is disposable, or use --interaction safe';

export interface FormLogin {
  readonly loginUrl: string;
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector: string;
  readonly successUrl: string;
}

export interface InitAnswers {
  readonly baseUrl: string;
  readonly framework: Framework;
  readonly interaction: Interaction;
  /** True only when the person said the data is disposable (prompt answer or explicit flag). */
  readonly acknowledgedDisposableData: boolean;
  readonly login?: FormLogin;
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function currentUsername(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    // userInfo() throws when the uid has no passwd entry (some containers); `by` is optional.
    return undefined;
  }
}

function acknowledgement(): NonNullable<LookoverConfig['acknowledgement']> {
  const by = currentUsername();
  return {
    disposableData: true,
    acknowledgedAt: new Date().toISOString(),
    ...(by === undefined ? {} : { by }),
  };
}

function formAuth(login: FormLogin) {
  return {
    type: 'form' as const,
    ...login,
    usernameEnv: AUTH_ENV.username,
    passwordEnv: AUTH_ENV.password,
  };
}

/**
 * The one place a `full` config comes into being. It refuses to without the acknowledgement, so
 * a caller validates here before anything is written to disk.
 */
export function buildConfig(answers: InitAnswers, root: string): LookoverConfig {
  if (answers.interaction === 'full' && !answers.acknowledgedDisposableData) {
    throw new LookoverError(
      'E_ACK_REQUIRED',
      'interaction is "full" but the disposable-data acknowledgement is missing',
      ACK_HINT,
    );
  }
  const result = configSchema.safeParse({
    baseUrl: answers.baseUrl,
    root,
    framework: answers.framework,
    interaction: answers.interaction,
    ...(answers.interaction === 'full' ? { acknowledgement: acknowledgement() } : {}),
    ...(answers.login === undefined ? {} : { auth: formAuth(answers.login) }),
  });
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new LookoverError(
      'E_CONFIG_INVALID',
      ['The answers do not make a valid config', ...lines].join('\n'),
    );
  }
  return result.data;
}
