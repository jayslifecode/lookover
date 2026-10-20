import { expect, test } from 'vitest';
import { summarise } from '../lib/summary.ts';

function organisation(id: number, registeredAt: string) {
  return { id, name: `Org ${id}`, phone: '12345678', email: `org${id}@org.example`, registeredAt };
}

test('summarise counts organisations and finds the first and latest registration', () => {
  const organisations = [
    organisation(1, '2024-03-01'),
    organisation(2, '2023-11-30'),
    organisation(3, '2025-01-15'),
  ];

  expect(summarise(organisations)).toEqual({
    organisationCount: 3,
    firstRegistration: '2023-11-30',
    latestRegistration: '2025-01-15',
  });
  expect(organisations.map((org) => org.id)).toEqual([1, 2, 3]);
});

test('summarise of no organisations shows a dash for the dates', () => {
  expect(summarise([])).toEqual({ organisationCount: 0, firstRegistration: '—', latestRegistration: '—' });
});
