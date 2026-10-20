import { describe, expect, test } from 'vitest';
import { DESTRUCTIVE_LINK_PATTERN, isDestructiveLink } from '../src/map/links.js';

describe('DESTRUCTIVE_LINK_PATTERN', () => {
  test.each([
    '/logout',
    '/account/sign-out',
    '/signout?next=/',
    '/items/3/delete',
    '/settings/reset/',
    '/orgs?action=delete',
    '/orgs?a=1&op=remove',
    '/users/sign_out',
    '/session/log_out',
    '/logoff',
  ])('matches %s', (path) => {
    expect(DESTRUCTIVE_LINK_PATTERN.test(path)).toBe(true);
  });

  test.each(['/logouts', '/logoffs', '/deleted-items', '/resettle', '/orgs?action=view', '/remove-me-not'])(
    'does not match %s',
    (path) => {
      expect(DESTRUCTIVE_LINK_PATTERN.test(path)).toBe(false);
    },
  );
});

describe('isDestructiveLink', () => {
  test('judges the path below the base path, so a base path like /reset/ is not destructive itself', () => {
    const base = new URL('http://localhost:3000/reset/');

    expect(isDestructiveLink(new URL('http://localhost:3000/reset'), base)).toBe(false);
    expect(isDestructiveLink(new URL('http://localhost:3000/reset/page.html'), base)).toBe(false);
    expect(isDestructiveLink(new URL('http://localhost:3000/reset/logout'), base)).toBe(true);
  });

  test('includes the query', () => {
    const base = new URL('http://localhost:3000/');

    expect(isDestructiveLink(new URL('http://localhost:3000/orgs?action=delete'), base)).toBe(true);
    expect(isDestructiveLink(new URL('http://localhost:3000/orgs?action=view'), base)).toBe(false);
  });
});
