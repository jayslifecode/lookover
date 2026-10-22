import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  defaultRoute,
  formatRoute,
  navigate,
  parseRoute,
  type Route,
  useRoute,
  viewRoute,
} from '../src/data/route';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
});

const ROUTES: readonly [Route, string][] = [
  [{ view: 'screens', screenId: '4a17c4d0a2', findingId: null }, '#/screens/4a17c4d0a2'],
  [
    { view: 'screens', screenId: '4a17c4d0a2', findingId: 'da77d007d373' },
    '#/screens/4a17c4d0a2?f=da77d007d373',
  ],
  [{ view: 'screens', screenId: null, findingId: null }, '#/screens'],
  [{ view: 'findings', findingId: null }, '#/findings'],
  [{ view: 'findings', findingId: 'fc8addc0486b' }, '#/findings?f=fc8addc0486b'],
  [{ view: 'drift', findingId: null }, '#/drift'],
  [{ view: 'drift', findingId: 'e9839cc1b237' }, '#/drift?f=e9839cc1b237'],
];

test.each(ROUTES)('%o round trips through %s', (route, hash) => {
  expect(formatRoute(route)).toBe(hash);
  expect(parseRoute(hash)).toEqual(route);
});

test('ids with reserved characters are encoded and come back the same', () => {
  const route: Route = { view: 'screens', screenId: 'a/b?c#d e', findingId: 'f&g=h+i' };
  const hash = formatRoute(route);
  expect(hash.slice(1)).not.toMatch(/[\s#&+]/u);
  expect(hash.split('/')).toHaveLength(3);
  expect(parseRoute(hash)).toEqual(route);
});

test('an empty, unknown or malformed hash is no route', () => {
  for (const hash of [
    '',
    '#',
    '#/',
    '#/nope',
    '#/worth-a-look',
    '#/screens/a/b',
    '#/findings/x',
    '#/screens/%E0%A4%A',
  ]) {
    expect(parseRoute(hash), hash).toBeNull();
  }
});

test('the default route is the first captured screen once one is known, else the findings', () => {
  expect(defaultRoute(null)).toEqual({ view: 'findings', findingId: null });
  expect(defaultRoute('4a17c4d0a2')).toEqual({ view: 'screens', screenId: '4a17c4d0a2', findingId: null });
  expect(viewRoute('screens', '4a17c4d0a2')).toEqual(defaultRoute('4a17c4d0a2'));
  expect(viewRoute('drift', '4a17c4d0a2')).toEqual({ view: 'drift', findingId: null });
});

function Probe() {
  const route = useRoute();
  return createElement('output', { 'data-testid': 'route' }, route === null ? 'none' : formatRoute(route));
}

const shown = () => screen.getByTestId('route').textContent;

test('useRoute follows navigate, and back and forward', async () => {
  render(createElement(Probe));
  expect(shown()).toBe('none');

  act(() => navigate({ view: 'findings', findingId: null }));
  expect(shown()).toBe('#/findings');
  act(() => navigate({ view: 'drift', findingId: null }));
  expect(shown()).toBe('#/drift');
  expect(window.location.hash).toBe('#/drift');

  act(() => window.history.back());
  await waitFor(() => expect(shown()).toBe('#/findings'));
  act(() => window.history.forward());
  await waitFor(() => expect(shown()).toBe('#/drift'));
});

test('navigating to the route already shown adds no history entry', () => {
  render(createElement(Probe));
  act(() => navigate({ view: 'findings', findingId: null }));
  const length = window.history.length;
  act(() => navigate({ view: 'findings', findingId: null }));
  expect(window.history.length).toBe(length);
});

test('a hash typed into the address bar is followed', async () => {
  render(createElement(Probe));
  act(() => {
    window.location.hash = '#/screens/57682dba9d';
  });
  await waitFor(() => expect(shown()).toBe('#/screens/57682dba9d'));
});
