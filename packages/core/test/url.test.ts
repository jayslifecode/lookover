import { describe, expect, test } from 'vitest';
import { isSameApp, normaliseUrl, resolveSeed, routeKey } from '../src/util/url.js';

const base = new URL('http://localhost:3000/app');

describe('normaliseUrl', () => {
  test.each([
    ['a bare hash', '#'],
    ['a fragment-only href', '#top'],
    ['a mailto link', 'mailto:jay@example.com'],
    ['a tel link', 'tel:+821012345678'],
    ['a javascript link', 'javascript:void(0)'],
    ['a javascript link in mixed case', 'JavaScript:void(0)'],
    ['a data URL', 'data:text/html,<p>hi</p>'],
    ['a blob URL', 'blob:http://localhost:3000/0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['an href that fails to parse', 'http://'],
  ])('returns null for %s', (_name, href) => {
    expect(normaliseUrl(href, base)).toBeNull();
  });

  test.each([
    ['removes a trailing slash', '/orgs/', 'http://localhost:3000/orgs'],
    ['keeps the root slash', '/', 'http://localhost:3000/'],
    ['collapses repeated trailing slashes', '/orgs//', 'http://localhost:3000/orgs'],
    ['sorts query parameters by key', '/orgs?b=2&a=1', 'http://localhost:3000/orgs?a=1&b=2'],
    ['keeps duplicate keys in their original order', '/q?b=2&a=1&a=0', 'http://localhost:3000/q?a=1&a=0&b=2'],
    ['drops the hash', '/orgs#members', 'http://localhost:3000/orgs'],
    ['drops the hash but keeps the query', '/orgs?a=1#members', 'http://localhost:3000/orgs?a=1'],
    ['lowercases the host but not the path', 'HTTP://LocalHost:3000/Foo/', 'http://localhost:3000/Foo'],
    ['drops a default port', 'http://localhost:80/x', 'http://localhost/x'],
    ['keeps other origins as they are', 'https://example.com/x/?b=1&a=2', 'https://example.com/x?a=2&b=1'],
    ['resolves a root-relative href against the base origin', '/settings/', 'http://localhost:3000/settings'],
  ])('%s', (_name, href, expected) => {
    expect(normaliseUrl(href, base)?.href).toBe(expected);
  });

  test('resolves a relative href against the base path', () => {
    const pageBase = new URL('http://localhost:3000/app/orgs/');

    expect(normaliseUrl('members', pageBase)?.href).toBe('http://localhost:3000/app/orgs/members');
    expect(normaliseUrl('../settings/', pageBase)?.href).toBe('http://localhost:3000/app/settings');
  });

  test('is idempotent', () => {
    const first = normaliseUrl('/orgs//?b=2&a=1#x', base);
    expect(first).not.toBeNull();

    const second = normaliseUrl(first?.href ?? '', base);

    expect(second?.href).toBe(first?.href);
  });

  test('does not mutate the base URL', () => {
    const own = new URL('http://localhost:3000/app/?z=1#frag');

    normaliseUrl('/orgs/?b=2', own);

    expect(own.href).toBe('http://localhost:3000/app/?z=1#frag');
  });
});

describe('isSameApp', () => {
  test.each([
    ['the base path itself', 'http://localhost:3000/app', true],
    ['the base path with a trailing slash', 'http://localhost:3000/app/', true],
    ['a path under the base', 'http://localhost:3000/app/x', true],
    ['a deeply nested path under the base', 'http://localhost:3000/app/x/y?z=1', true],
    ['a different path on the same origin', 'http://localhost:3000/other', false],
    ['a path that only shares the prefix text', 'http://localhost:3000/application', false],
    ['the origin root', 'http://localhost:3000/', false],
    ['a different port', 'http://localhost:3001/app', false],
    ['a different scheme', 'https://localhost:3000/app', false],
    ['a different host', 'http://example.com/app', false],
  ])('%s', (_name, href, expected) => {
    expect(isSameApp(new URL(href), base)).toBe(expected);
  });

  test('treats a base with a trailing slash as a directory prefix', () => {
    const slashBase = new URL('http://localhost:3000/app/');

    expect(isSameApp(new URL('http://localhost:3000/app'), slashBase)).toBe(true);
    expect(isSameApp(new URL('http://localhost:3000/app/x'), slashBase)).toBe(true);
    expect(isSameApp(new URL('http://localhost:3000/application'), slashBase)).toBe(false);
  });

  test('matches everything on the origin when the base path is the root', () => {
    const rootBase = new URL('http://localhost:3000/');

    expect(isSameApp(new URL('http://localhost:3000/anything/at/all'), rootBase)).toBe(true);
    expect(isSameApp(new URL('http://localhost:3001/anything'), rootBase)).toBe(false);
  });
});

describe('routeKey', () => {
  test('is the pathname plus the search, without origin or hash', () => {
    expect(routeKey(new URL('http://localhost:3000/orgs?a=1&b=2#members'))).toBe('/orgs?a=1&b=2');
  });

  test('is just the pathname when there is no query', () => {
    expect(routeKey(new URL('http://localhost:3000/orgs'))).toBe('/orgs');
  });

  test('is stable across query orderings once normalised', () => {
    const left = normaliseUrl('/orgs?b=2&a=1', base);
    const right = normaliseUrl('/orgs/?a=1&b=2#x', base);

    expect(left && routeKey(left)).toBe('/orgs?a=1&b=2');
    expect(right && routeKey(right)).toBe('/orgs?a=1&b=2');
  });
});

// Results are normalised like every crawl URL, so `/sub/` comes back as `/sub`.
describe('resolveSeed', () => {
  const origin = 'http://127.0.0.1:3000';

  test.each([`${origin}/sub/`, `${origin}/sub`])(
    'keeps the base path of %s for a seed starting with /',
    (base) => {
      expect(resolveSeed('/', new URL(base))?.href).toBe(`${origin}/sub`);
      expect(resolveSeed('/orgs.html', new URL(base))?.href).toBe(`${origin}/sub/orgs.html`);
    },
  );

  test.each([`${origin}/`, origin])('changes nothing under the root base URL %s', (base) => {
    expect(resolveSeed('/', new URL(base))?.href).toBe(`${origin}/`);
    expect(resolveSeed('/orgs.html', new URL(base))?.href).toBe(`${origin}/orgs.html`);
  });

  test('uses an absolute seed as is', () => {
    expect(resolveSeed(`${origin}/orgs.html`, new URL(`${origin}/sub/`))?.href).toBe(`${origin}/orgs.html`);
  });

  test('returns null for a seed that cannot be navigated', () => {
    expect(resolveSeed('mailto:x@y.z', new URL(`${origin}/sub/`))).toBeNull();
  });
});
