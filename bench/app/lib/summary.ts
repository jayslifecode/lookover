import type { Organisation } from './store';

export interface RegistrationSummary {
  organisationCount: number;
  /** `YYYY-MM-DD`, or a dash when there are no organisations. */
  firstRegistration: string;
  latestRegistration: string;
}

const NO_DATE = '—';

/** `YYYY-MM-DD` strings sort chronologically, so no date parsing is needed. */
export function summarise(organisations: readonly Organisation[]): RegistrationSummary {
  const dates = organisations.map((org) => org.registeredAt).toSorted();
  return {
    organisationCount: organisations.length,
    firstRegistration: dates[0] ?? NO_DATE,
    latestRegistration: dates.at(-1) ?? NO_DATE,
  };
}
