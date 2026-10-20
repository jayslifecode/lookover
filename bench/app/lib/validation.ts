/*
 * Server-side checks for the bench forms. They mirror the constraints the inputs declare
 * (`required`, `pattern`, `type="email"`), so a submission that skips the browser's validation
 * is still rejected. Dates are typed as text in the one format the app shows, `YYYY-MM-DD`.
 */

export type OrganisationField = 'name' | 'phone' | 'email' | 'registeredAt';
export type SettingsField = 'workspaceName' | 'contactEmail' | 'timeZone';

export type FieldErrors<F extends string> = Partial<Record<F, string>>;

export interface FormResult<F extends string> {
  values: Record<F, string>;
  errors: FieldErrors<F>;
}

/*
 * For the `pattern` attribute, which the browser anchors to the whole value. The server's checks
 * are built from the same strings, so the two cannot drift apart.
 */
export const PHONE_PATTERN = '\\d{8}';
export const DATE_PATTERN = '\\d{4}-\\d{2}-\\d{2}';
export const DATE_FORMAT = 'YYYY-MM-DD';
export const TIME_ZONES: readonly string[] = [
  'UTC',
  'Asia/Seoul',
  'Asia/Ulaanbaatar',
  'Europe/London',
  'America/New_York',
];

const PHONE = new RegExp(`^${PHONE_PATTERN}$`);
const ISO_DATE = new RegExp(`^${DATE_PATTERN}$`);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** `YYYY-MM-DD` naming a day that exists (no 30 February). */
function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** The message of every check that failed, keyed by its field. */
function collectErrors<F extends string>(checks: readonly (readonly [F, string | null])[]): FieldErrors<F> {
  return Object.fromEntries(checks.filter(([, message]) => message !== null)) as FieldErrors<F>;
}

export function hasErrors<F extends string>(errors: FieldErrors<F>): boolean {
  return Object.keys(errors).length > 0;
}

export function readOrganisationForm(formData: FormData): FormResult<OrganisationField> {
  const values = {
    name: text(formData, 'name'),
    phone: text(formData, 'phone'),
    email: text(formData, 'email'),
    registeredAt: text(formData, 'registeredAt'),
  };
  const errors = collectErrors<OrganisationField>([
    ['name', values.name === '' ? 'Enter the organisation name.' : null],
    ['phone', PHONE.test(values.phone) ? null : 'Enter the phone number as 8 digits.'],
    ['email', EMAIL.test(values.email) ? null : 'Enter an email address like name@example.com.'],
    ['registeredAt', isIsoDate(values.registeredAt) ? null : `Enter the date as ${DATE_FORMAT}.`],
  ]);
  return { values, errors };
}

export function readSettingsForm(formData: FormData): FormResult<SettingsField> {
  const values = {
    workspaceName: text(formData, 'workspaceName'),
    contactEmail: text(formData, 'contactEmail'),
    timeZone: text(formData, 'timeZone'),
  };
  const errors = collectErrors<SettingsField>([
    ['workspaceName', values.workspaceName === '' ? 'Enter the workspace name.' : null],
    [
      'contactEmail',
      EMAIL.test(values.contactEmail) ? null : 'Enter an email address like name@example.com.',
    ],
    ['timeZone', TIME_ZONES.includes(values.timeZone) ? null : 'Choose a time zone from the list.'],
  ]);
  return { values, errors };
}

/** A route's `[id]` segment as an organisation id; `null` unless it is a positive integer written plainly. */
export function parseId(raw: string): number | null {
  return POSITIVE_INTEGER.test(raw) ? Number(raw) : null;
}
