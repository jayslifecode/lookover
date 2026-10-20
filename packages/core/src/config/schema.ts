import { z } from 'zod';

const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5-5';
const DEFAULT_CLASSIFY_MODEL = 'claude-haiku-5-5';
const DEFAULT_USERNAME_ENV = 'LOOKOVER_USERNAME';
const DEFAULT_PASSWORD_ENV = 'LOOKOVER_PASSWORD';

const viewportSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const defaultViewports: z.input<typeof viewportSchema>[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const acknowledgementSchema = z.object({
  disposableData: z.literal(true),
  acknowledgedAt: z.iso.datetime(),
  by: z.string().optional(),
});

// Credentials never live in the config: the form variant stores the names of the
// environment variables that hold them.
const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('storageState'),
    /** A Playwright storage state file, relative to the project directory. */
    path: z.string(),
    /**
     * The app's login page, app-relative like a form login's `loginUrl` (or a full URL on the app's
     * origin). With it, a crawl that lands there from another page has lost the saved session, and the
     * run fails with `E_AUTH_FAILED` (a storage state cannot log in again). Without it a lost session
     * goes unnoticed: the login page is captured in place of each screen behind it.
     */
    loginUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal('form'),
    loginUrl: z.string(),
    usernameSelector: z.string(),
    passwordSelector: z.string(),
    submitSelector: z.string(),
    usernameEnv: z.string().default(DEFAULT_USERNAME_ENV),
    passwordEnv: z.string().default(DEFAULT_PASSWORD_ENV),
    successUrl: z.string(),
  }),
]);

const modelSchema = z.object({
  judge: z.string().default(DEFAULT_JUDGE_MODEL),
  classify: z.string().default(DEFAULT_CLASSIFY_MODEL),
});

export const configSchema = z.object({
  baseUrl: z.url(),
  root: z.string().default('.'),
  framework: z.enum(['next', 'vite-react', 'unknown']).default('next'),
  interaction: z.enum(['full', 'safe']),
  acknowledgement: acknowledgementSchema.optional(),
  allowHosts: z.array(z.string()).default([]),
  confirmedBackendHosts: z.array(z.string()).default([]),
  // A factory: a shared default would let one parsed config's change show up in every other one.
  viewports: z.array(viewportSchema).default(() => defaultViewports.map((viewport) => ({ ...viewport }))),
  maxScreens: z.number().int().positive().default(40),
  maxPerRoute: z.number().int().positive().default(2),
  auth: authSchema.default({ type: 'none' }),
  model: modelSchema.prefault({}),
});

export type LookoverConfig = z.output<typeof configSchema>;
