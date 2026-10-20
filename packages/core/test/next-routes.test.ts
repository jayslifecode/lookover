import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { discoverNextRoutes, matchRoute, routePatternFromPath } from '../src/map/next-routes.js';
import type { RouteInfo } from '../src/map/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lookover-next-routes-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeTree(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '');
  }
}

async function discoverPatterns(): Promise<string[]> {
  const routes = await discoverNextRoutes(root);
  return routes.map((route) => route.pattern);
}

function filesystemRoute(pattern: string): RouteInfo {
  return { pattern, source: 'filesystem' };
}

function linkRoute(pattern: string): RouteInfo {
  return { pattern, source: 'link' };
}

describe('discoverNextRoutes: app router', () => {
  test('finds pages, strips route groups and skips slots, private folders and api', async () => {
    await writeTree([
      'app/page.tsx',
      'app/(marketing)/pricing/page.tsx',
      'app/organisations/page.tsx',
      'app/organisations/[id]/page.tsx',
      'app/organisations/[id]/@modal/page.tsx',
      'app/_private/page.tsx',
      'app/api/route.ts',
      'app/docs/[...slug]/page.mdx',
    ]);

    expect(await discoverPatterns()).toEqual([
      '/',
      '/docs/[...slug]',
      '/organisations',
      '/organisations/[id]',
      '/pricing',
    ]);
  });

  test('returns filesystem routes with the page file relative to root using posix separators', async () => {
    await writeTree(['app/page.tsx', 'app/(marketing)/pricing/page.tsx', 'app/docs/[...slug]/page.mdx']);

    expect(await discoverNextRoutes(root)).toEqual([
      { pattern: '/', source: 'filesystem', file: 'app/page.tsx' },
      { pattern: '/docs/[...slug]', source: 'filesystem', file: 'app/docs/[...slug]/page.mdx' },
      { pattern: '/pricing', source: 'filesystem', file: 'app/(marketing)/pricing/page.tsx' },
    ]);
  });

  test('accepts every page extension and ignores other files in the route folder', async () => {
    await writeTree([
      'app/ts/page.ts',
      'app/jsx/page.jsx',
      'app/js/page.js',
      'app/mdx/page.mdx',
      'app/layout/layout.tsx',
      'app/loading/loading.tsx',
      'app/handler/route.ts',
      'app/styles/page.css',
      'app/tested/page.test.tsx',
      'app/tested/page.tsx.snap',
    ]);

    expect(await discoverPatterns()).toEqual(['/js', '/jsx', '/mdx', '/ts']);
  });

  test('keeps dynamic, catch-all and optional catch-all segments verbatim', async () => {
    await writeTree([
      'app/[tenant]/page.tsx',
      'app/[tenant]/files/[...path]/page.tsx',
      'app/help/[[...topic]]/page.tsx',
    ]);

    expect(await discoverPatterns()).toEqual([
      '/[tenant]',
      '/[tenant]/files/[...path]',
      '/help/[[...topic]]',
    ]);
  });

  test('removes nested route groups at any depth', async () => {
    await writeTree(['app/(a)/(b)/team/(c)/members/page.tsx']);

    expect(await discoverPatterns()).toEqual(['/team/members']);
  });

  test('skips parallel slots and private folders at any depth, along with everything below them', async () => {
    await writeTree([
      'app/@modal/login/page.tsx',
      'app/shop/@cart/page.tsx',
      'app/shop/@cart/items/page.tsx',
      'app/shop/_components/page.tsx',
      'app/shop/_components/deep/page.tsx',
      'app/shop/page.tsx',
    ]);

    expect(await discoverPatterns()).toEqual(['/shop']);
  });

  test('skips the top-level api tree, including behind a route group, but keeps a nested api page', async () => {
    await writeTree([
      'app/api/users/page.tsx',
      'app/(backend)/api/health/page.tsx',
      'app/dashboard/api/page.tsx',
    ]);

    expect(await discoverPatterns()).toEqual(['/dashboard/api']);
  });

  test('skips intercepting route folders, which have no directly reachable url', async () => {
    await writeTree([
      'app/feed/page.tsx',
      'app/feed/(.)photo/[id]/page.tsx',
      'app/feed/(..)photo/[id]/page.tsx',
      'app/feed/(..)(..)photo/[id]/page.tsx',
      'app/feed/(...)photo/[id]/page.tsx',
      'app/photo/[id]/page.tsx',
    ]);

    expect(await discoverPatterns()).toEqual(['/feed', '/photo/[id]']);
  });

  test('ignores node_modules and dot-directories', async () => {
    await writeTree([
      'app/page.tsx',
      'app/node_modules/pkg/page.tsx',
      'app/.next/page.tsx',
      'app/docs/.cache/page.tsx',
    ]);

    expect(await discoverPatterns()).toEqual(['/']);
  });

  test('collapses pages that resolve to the same pattern and keeps the first file by path', async () => {
    await writeTree(['app/(b)/pricing/page.tsx', 'app/(a)/pricing/page.tsx', 'app/pricing/page.tsx']);

    expect(await discoverNextRoutes(root)).toEqual([
      { pattern: '/pricing', source: 'filesystem', file: 'app/(a)/pricing/page.tsx' },
    ]);
  });

  test('falls back to src/app when app is absent', async () => {
    await writeTree(['src/app/page.tsx', 'src/app/settings/page.tsx']);

    expect(await discoverNextRoutes(root)).toEqual([
      { pattern: '/', source: 'filesystem', file: 'src/app/page.tsx' },
      { pattern: '/settings', source: 'filesystem', file: 'src/app/settings/page.tsx' },
    ]);
  });

  test('prefers app over src/app when both exist', async () => {
    await writeTree(['app/page.tsx', 'src/app/ignored/page.tsx']);

    expect(await discoverPatterns()).toEqual(['/']);
  });
});

describe('discoverNextRoutes: pages router', () => {
  test('finds pages, maps index to the directory and skips special files and api', async () => {
    await writeTree([
      'pages/index.tsx',
      'pages/about.tsx',
      'pages/_app.tsx',
      'pages/api/x.ts',
      'pages/blog/[slug].tsx',
    ]);

    expect(await discoverPatterns()).toEqual(['/', '/about', '/blog/[slug]']);
  });

  test('returns filesystem routes with the page file relative to root', async () => {
    await writeTree(['pages/index.tsx', 'pages/blog/index.tsx', 'pages/blog/[slug].tsx']);

    expect(await discoverNextRoutes(root)).toEqual([
      { pattern: '/', source: 'filesystem', file: 'pages/index.tsx' },
      { pattern: '/blog', source: 'filesystem', file: 'pages/blog/index.tsx' },
      { pattern: '/blog/[slug]', source: 'filesystem', file: 'pages/blog/[slug].tsx' },
    ]);
  });

  test('skips _document, _error, 404, 500 and declaration files at the top level', async () => {
    await writeTree([
      'pages/about.tsx',
      'pages/_document.tsx',
      'pages/_error.tsx',
      'pages/404.tsx',
      'pages/500.tsx',
      'pages/types.d.ts',
    ]);

    expect(await discoverPatterns()).toEqual(['/about']);
  });

  test('keeps nested files that share a special name, since they are real routes', async () => {
    await writeTree(['pages/blog/404.tsx', 'pages/blog/_app.tsx']);

    expect(await discoverPatterns()).toEqual(['/blog/404', '/blog/_app']);
  });

  test('accepts every page extension', async () => {
    await writeTree(['pages/a.tsx', 'pages/b.ts', 'pages/c.jsx', 'pages/d.js', 'pages/e.mdx', 'pages/f.css']);

    expect(await discoverPatterns()).toEqual(['/a', '/b', '/c', '/d', '/e']);
  });

  test('keeps catch-all segments verbatim', async () => {
    await writeTree(['pages/docs/[...slug].tsx', 'pages/shop/[[...filters]].tsx']);

    expect(await discoverPatterns()).toEqual(['/docs/[...slug]', '/shop/[[...filters]]']);
  });

  test('does not treat parenthesised folders as route groups, which only the app router has', async () => {
    await writeTree(['pages/(legacy)/about.tsx']);

    expect(await discoverPatterns()).toEqual(['/(legacy)/about']);
  });

  test('ignores node_modules and dot-directories', async () => {
    await writeTree(['pages/index.tsx', 'pages/node_modules/pkg/x.tsx', 'pages/.cache/y.tsx']);

    expect(await discoverPatterns()).toEqual(['/']);
  });

  test('falls back to src/pages when pages is absent and prefers pages when both exist', async () => {
    await writeTree(['src/pages/index.tsx', 'src/pages/contact.tsx']);
    expect(await discoverNextRoutes(root)).toEqual([
      { pattern: '/', source: 'filesystem', file: 'src/pages/index.tsx' },
      { pattern: '/contact', source: 'filesystem', file: 'src/pages/contact.tsx' },
    ]);

    await writeTree(['pages/index.tsx']);
    expect(await discoverPatterns()).toEqual(['/']);
  });
});

describe('discoverNextRoutes: both routers and missing directories', () => {
  test('merges app and pages routes, deduplicated by pattern and sorted', async () => {
    await writeTree([
      'app/zeta/page.tsx',
      'app/about/page.tsx',
      'pages/about.tsx',
      'pages/index.tsx',
      'pages/blog/[slug].tsx',
    ]);

    const routes = await discoverNextRoutes(root);

    expect(routes.map((route) => route.pattern)).toEqual(['/', '/about', '/blog/[slug]', '/zeta']);
    expect(routes.find((route) => route.pattern === '/about')?.file).toBe('app/about/page.tsx');
  });

  test('returns an empty list when neither router directory exists', async () => {
    await writeTree(['README.md', 'lib/util.ts']);

    expect(await discoverNextRoutes(root)).toEqual([]);
  });

  test('returns an empty list when the root itself does not exist', async () => {
    expect(await discoverNextRoutes(join(root, 'missing'))).toEqual([]);
  });

  test('ignores an app path that is a file rather than a directory', async () => {
    await writeTree(['app', 'pages/index.tsx']);

    expect(await discoverPatterns()).toEqual(['/']);
  });
});

describe('matchRoute', () => {
  const routes: RouteInfo[] = [
    '/',
    '/docs/[...slug]',
    '/organisations',
    '/organisations/[id]',
    '/organisations/new',
    '/pricing',
  ].map(filesystemRoute);

  test('matches a static pattern exactly', () => {
    expect(matchRoute('/organisations', routes)?.pattern).toBe('/organisations');
    expect(matchRoute('/', routes)?.pattern).toBe('/');
  });

  test('matches a dynamic segment', () => {
    expect(matchRoute('/organisations/42', routes)?.pattern).toBe('/organisations/[id]');
  });

  test('matches a catch-all segment across several path segments', () => {
    expect(matchRoute('/docs/a/b', routes)?.pattern).toBe('/docs/[...slug]');
    expect(matchRoute('/docs/a', routes)?.pattern).toBe('/docs/[...slug]');
  });

  test('returns null when nothing matches', () => {
    expect(matchRoute('/nope', routes)).toBeNull();
    expect(matchRoute('/organisations/42/edit', routes)).toBeNull();
    expect(matchRoute('/', [])).toBeNull();
  });

  test('returns the route object it matched', () => {
    const match = matchRoute('/pricing', routes);

    expect(match).toBe(routes[5]);
  });

  test('ignores a trailing slash except on the root', () => {
    expect(matchRoute('/organisations/', routes)?.pattern).toBe('/organisations');
    expect(matchRoute('/organisations/42/', routes)?.pattern).toBe('/organisations/[id]');
    expect(matchRoute('/', routes)?.pattern).toBe('/');
  });

  test('prefers a static pattern over a dynamic one that also matches', () => {
    expect(matchRoute('/organisations/new', routes)?.pattern).toBe('/organisations/new');
  });

  describe('precedence among matching dynamic patterns', () => {
    /** Asserts the pick in both input orders, so the order of `routes` can never be what decides it. */
    function expectPick(pathname: string, candidates: readonly RouteInfo[], expected: RouteInfo): void {
      expect(matchRoute(pathname, candidates)).toBe(expected);
      expect(matchRoute(pathname, candidates.toReversed())).toBe(expected);
    }

    test('prefers [id] over [...slug] even though the catch-all pattern is longer', () => {
      const dynamic = filesystemRoute('/docs/[id]');
      const catchAll = filesystemRoute('/docs/[...slug]');

      expectPick('/docs/x', [dynamic, catchAll], dynamic);
      expectPick('/docs/x/y', [dynamic, catchAll], catchAll);
    });

    test('decides by segment kind, not by the length of the parameter name', () => {
      const longName = filesystemRoute('/docs/[categoryId]');
      const shortCatchAll = filesystemRoute('/docs/[...s]');
      expectPick('/docs/x', [longName, shortCatchAll], longName);

      const shortName = filesystemRoute('/docs/[i]');
      const longCatchAll = filesystemRoute('/docs/[...slugs]');
      expectPick('/docs/x', [shortName, longCatchAll], shortName);
    });

    test('resolves a static first segment before a dynamic one', () => {
      const shopItem = filesystemRoute('/shop/[id]');
      const tenantSettings = filesystemRoute('/[tenant]/settings');

      expectPick('/shop/settings', [shopItem, tenantSettings], shopItem);
      expectPick('/acme/settings', [shopItem, tenantSettings], tenantSettings);
    });

    test('lets the first differing segment decide, later segments notwithstanding', () => {
      const staticMiddle = filesystemRoute('/[a]/b/[c]');
      const staticLast = filesystemRoute('/[a]/[b]/c');

      expectPick('/x/b/c', [staticMiddle, staticLast], staticMiddle);
    });

    test('prefers a deeper specific pattern over a catch-all that also matches', () => {
      const category = filesystemRoute('/shop/[category]/new');
      const catchAll = filesystemRoute('/shop/[...slug]');

      expectPick('/shop/shoes/new', [category, catchAll], category);
      expectPick('/shop/shoes/old', [category, catchAll], catchAll);
    });

    test('ranks [[...x]] last, after [id] and [...x]', () => {
      const dynamic = filesystemRoute('/docs/[id]');
      const catchAll = filesystemRoute('/docs/[...slug]');
      const optional = filesystemRoute('/docs/[[...slug]]');

      expectPick('/docs/x', [dynamic, catchAll, optional], dynamic);
      expectPick('/docs/x/y', [dynamic, catchAll, optional], catchAll);
      expectPick('/docs/x/y', [catchAll, optional], catchAll);
      expectPick('/docs', [dynamic, catchAll, optional], optional);
    });

    test('prefers a pattern that has ended over one still holding an optional catch-all', () => {
      const tenant = filesystemRoute('/[tenant]');
      const tenantRest = filesystemRoute('/[tenant]/[[...rest]]');

      expectPick('/acme', [tenant, tenantRest], tenant);
      expectPick('/acme/billing', [tenant, tenantRest], tenantRest);
    });

    test('prefers a filesystem route over a link route of the same shape', () => {
      const fromLink = linkRoute('/docs/[id]');
      const fromFiles = filesystemRoute('/docs/[slug]');
      expectPick('/docs/x', [fromLink, fromFiles], fromFiles);

      const linkTwin = linkRoute('/docs/[id]');
      const fileTwin = filesystemRoute('/docs/[id]');
      expectPick('/docs/x', [linkTwin, fileTwin], fileTwin);
    });

    test('lets segment kind outrank the source, so a link route can still win', () => {
      const specificLink = linkRoute('/docs/[id]');
      const generalFile = filesystemRoute('/docs/[...slug]');

      expectPick('/docs/x', [specificLink, generalFile], specificLink);
    });

    test('breaks a remaining tie by pattern text', () => {
      const first = filesystemRoute('/docs/[a]');
      const second = filesystemRoute('/docs/[b]');

      expectPick('/docs/x', [second, first], first);
    });
  });

  test('does not let a dynamic segment span a slash or match an empty segment', () => {
    const single = ['/organisations/[id]'].map(filesystemRoute);

    expect(matchRoute('/organisations/1/2', single)).toBeNull();
    expect(matchRoute('/organisations/', single)).toBeNull();
  });

  test('requires at least one segment for a catch-all', () => {
    const docs = ['/docs/[...slug]'].map(filesystemRoute);

    expect(matchRoute('/docs', docs)).toBeNull();
  });

  test('lets an optional catch-all match the bare path as well as deeper paths', () => {
    const help = ['/help/[[...topic]]'].map(filesystemRoute);

    expect(matchRoute('/help', help)?.pattern).toBe('/help/[[...topic]]');
    expect(matchRoute('/help/billing', help)?.pattern).toBe('/help/[[...topic]]');
    expect(matchRoute('/help/billing/refunds', help)?.pattern).toBe('/help/[[...topic]]');
    expect(matchRoute('/helpful', help)).toBeNull();
  });

  test('lets a root optional catch-all match the root path', () => {
    const everything = ['/[[...all]]'].map(filesystemRoute);

    expect(matchRoute('/', everything)?.pattern).toBe('/[[...all]]');
    expect(matchRoute('/a/b', everything)?.pattern).toBe('/[[...all]]');
  });

  test('treats regex characters in a pattern literally', () => {
    const dotted = ['/a.b/[id]', '/c+d'].map(filesystemRoute);

    expect(matchRoute('/a.b/1', dotted)?.pattern).toBe('/a.b/[id]');
    expect(matchRoute('/aXb/1', dotted)).toBeNull();
    expect(matchRoute('/c+d', dotted)?.pattern).toBe('/c+d');
    expect(matchRoute('/ccd', dotted)).toBeNull();
  });

  test('does not match across a partial literal prefix', () => {
    expect(matchRoute('/organisations-archive/1', routes)).toBeNull();
  });
});

describe('routePatternFromPath', () => {
  test('replaces uuid and numeric segments with [param]', () => {
    expect(routePatternFromPath('/orders/550e8400-e29b-41d4-a716-446655440000/items/12')).toBe(
      '/orders/[param]/items/[param]',
    );
  });

  test('replaces an uppercase uuid', () => {
    expect(routePatternFromPath('/orders/550E8400-E29B-41D4-A716-446655440000')).toBe('/orders/[param]');
  });

  test('replaces opaque ids of 20 or more base64url characters', () => {
    expect(routePatternFromPath('/s/V1StGXR8_Z5jdHi6B-myT')).toBe('/s/[param]');
    expect(routePatternFromPath('/s/abcdefghij0123456789')).toBe('/s/[param]');
  });

  test('keeps segments that are shorter than 20 characters or not id-shaped', () => {
    expect(routePatternFromPath('/users/user-123/settings')).toBe('/users/user-123/settings');
    expect(routePatternFromPath('/s/abcdefghij012345678')).toBe('/s/abcdefghij012345678');
    expect(routePatternFromPath('/files/report.final.pdf')).toBe('/files/report.final.pdf');
  });

  test('keeps the root and purely static paths', () => {
    expect(routePatternFromPath('/')).toBe('/');
    expect(routePatternFromPath('/pricing')).toBe('/pricing');
  });
});
