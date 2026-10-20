import { describe, expect, test } from 'vitest';
import {
  DATE_PATTERN,
  PHONE_PATTERN,
  parseId,
  readOrganisationForm,
  readSettingsForm,
} from '../lib/validation.ts';

/** How the browser applies a `pattern` attribute: anchored to the whole value. */
function matchesPattern(pattern: string, value: string): boolean {
  return new RegExp(`^(?:${pattern})$`, 'v').test(value);
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

const VALID_ORGANISATION = {
  name: 'Northwind Logistics',
  phone: '99112233',
  email: 'contact@northwind.example',
  registeredAt: '2023-02-14',
};

describe('readOrganisationForm', () => {
  test('accepts a valid organisation and trims its values', () => {
    const result = readOrganisationForm(form({ ...VALID_ORGANISATION, name: '  Northwind Logistics ' }));

    expect(result).toEqual({ values: VALID_ORGANISATION, errors: {} });
  });

  test('reports every missing field', () => {
    const result = readOrganisationForm(form({}));

    expect(Object.keys(result.errors).sort()).toEqual(['email', 'name', 'phone', 'registeredAt']);
  });

  test.each(['9911223', '991122334', '9911-2233', 'abcdefgh'])('rejects the phone %s', (phone) => {
    expect(readOrganisationForm(form({ ...VALID_ORGANISATION, phone })).errors).toHaveProperty('phone');
  });

  test.each(['2023-02-30', '14/02/2023', '2023-2-14'])('rejects the date %s', (registeredAt) => {
    expect(readOrganisationForm(form({ ...VALID_ORGANISATION, registeredAt })).errors).toHaveProperty(
      'registeredAt',
    );
  });

  test('rejects an email without a domain', () => {
    expect(readOrganisationForm(form({ ...VALID_ORGANISATION, email: 'contact@' })).errors).toHaveProperty(
      'email',
    );
  });
});

describe('input patterns agree with the server checks', () => {
  // Shape only: the server also rejects days that do not exist (2023-02-30), which a pattern cannot.
  test.each(['2023-02-14', '2023-2-14', '14/02/2023', '2023-02-140', ''])('date %j', (registeredAt) => {
    const { errors } = readOrganisationForm(form({ ...VALID_ORGANISATION, registeredAt }));
    expect(matchesPattern(DATE_PATTERN, registeredAt)).toBe(!('registeredAt' in errors));
  });

  test.each(['99112233', '9911223', '991122334', 'abcdefgh'])('phone %j', (phone) => {
    const isServerValid = !('phone' in readOrganisationForm(form({ ...VALID_ORGANISATION, phone })).errors);
    expect(matchesPattern(PHONE_PATTERN, phone)).toBe(isServerValid);
  });
});

describe('readSettingsForm', () => {
  const valid = { workspaceName: 'Bench', contactEmail: 'admin@bench.example', timeZone: 'UTC' };

  test('accepts valid settings', () => {
    expect(readSettingsForm(form(valid))).toEqual({ values: valid, errors: {} });
  });

  test('rejects a time zone outside the list', () => {
    expect(readSettingsForm(form({ ...valid, timeZone: 'Mars/Olympus' })).errors).toHaveProperty('timeZone');
  });
});

describe('parseId', () => {
  test('parses a positive integer', () => {
    expect(parseId('12')).toBe(12);
  });

  test.each(['', '0', '01', '1.5', '-1', 'abc', ' 1'])('rejects %j', (raw) => {
    expect(parseId(raw)).toBeNull();
  });
});
