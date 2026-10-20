import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RouteInfo } from './types.js';

const PAGE_EXTENSIONS = 'tsx|ts|jsx|js|mdx';
const APP_PAGE_FILE = new RegExp(`^page\\.(?:${PAGE_EXTENSIONS})$`);
const PAGES_FILE_EXTENSION = new RegExp(`\\.(?:${PAGE_EXTENSIONS})$`);
const DECLARATION_FILE = /\.d\.ts$/;

const ROUTE_GROUP = /^\(.+\)$/;
/** `(.)x`, `(..)x`, `(..)(..)x` and `(...)x`: rendered over another route, never reached directly. */
const INTERCEPTING_ROUTE = /^\(\.{1,3}\)/;
const PAGES_SPECIAL_FILES: ReadonlySet<string> = new Set(['_app', '_document', '_error', '404', '500']);

const API_SEGMENT = 'api';
const INDEX_SEGMENT = 'index';
const IGNORED_DIRECTORY = 'node_modules';
const APP_DIRECTORIES: readonly string[] = ['app', 'src/app'];
const PAGES_DIRECTORIES: readonly string[] = ['pages', 'src/pages'];

type DirectoryFilter = (path: readonly string[]) => boolean;

function isIgnoredDirectory(name: string): boolean {
  return name === IGNORED_DIRECTORY || name.startsWith('.');
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** The first candidate (relative to `root`, posix) that exists as a directory. */
async function firstDirectory(root: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isDirectory(join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * Every file under `baseDir` as a posix path relative to it. A directory is
 * not entered when it is ignored (node_modules, dot-directories) or when
 * `isSkippedDirectory` rejects its path, so skipped subtrees cost nothing.
 */
async function listFiles(baseDir: string, isSkippedDirectory: DirectoryFilter): Promise<string[]> {
  async function walk(parents: readonly string[]): Promise<string[]> {
    const entries = await readdir(join(baseDir, ...parents), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry): Promise<string[]> => {
        const path = [...parents, entry.name];
        if (entry.isFile()) return [path.join('/')];
        if (!entry.isDirectory() || isIgnoredDirectory(entry.name) || isSkippedDirectory(path)) return [];
        return walk(path);
      }),
    );
    return nested.flat();
  }

  return walk([]);
}

function withoutRouteGroups(segments: readonly string[]): string[] {
  return segments.filter((segment) => !ROUTE_GROUP.test(segment));
}

function patternFromSegments(segments: readonly string[]): string {
  return `/${segments.join('/')}`;
}

function isSkippedAppDirectory(path: readonly string[]): boolean {
  const name = path.at(-1) ?? '';
  if (name.startsWith('@') || name.startsWith('_') || INTERCEPTING_ROUTE.test(name)) return true;
  // Only the top-level api folder is the conventional handler tree; a nested `api` folder can be a page.
  return name === API_SEGMENT && withoutRouteGroups(path).length === 1;
}

function appRouteFromFile(directory: string, file: string): RouteInfo | null {
  const segments = file.split('/');
  if (!APP_PAGE_FILE.test(segments.at(-1) ?? '')) return null;
  return {
    pattern: patternFromSegments(withoutRouteGroups(segments.slice(0, -1))),
    source: 'filesystem',
    file: `${directory}/${file}`,
  };
}

function isSkippedPagesDirectory(path: readonly string[]): boolean {
  return path.length === 1 && path[0] === API_SEGMENT;
}

function pagesRouteFromFile(directory: string, file: string): RouteInfo | null {
  const segments = file.split('/');
  const fileName = segments.at(-1) ?? '';
  if (!PAGES_FILE_EXTENSION.test(fileName) || DECLARATION_FILE.test(fileName)) return null;

  const pageName = fileName.replace(PAGES_FILE_EXTENSION, '');
  const isTopLevel = segments.length === 1;
  if (isTopLevel && PAGES_SPECIAL_FILES.has(pageName)) return null;

  const routeSegments =
    pageName === INDEX_SEGMENT ? segments.slice(0, -1) : [...segments.slice(0, -1), pageName];
  return { pattern: patternFromSegments(routeSegments), source: 'filesystem', file: `${directory}/${file}` };
}

async function discoverRoutes(
  root: string,
  candidates: readonly string[],
  isSkippedDirectory: DirectoryFilter,
  routeFromFile: (directory: string, file: string) => RouteInfo | null,
): Promise<RouteInfo[]> {
  const directory = await firstDirectory(root, candidates);
  if (directory === null) return [];

  const files = await listFiles(join(root, directory), isSkippedDirectory);
  return files.flatMap((file) => routeFromFile(directory, file) ?? []);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sortAndDeduplicate(routes: readonly RouteInfo[]): RouteInfo[] {
  const sorted = routes.toSorted(
    (a, b) => compareText(a.pattern, b.pattern) || compareText(a.file ?? '', b.file ?? ''),
  );
  return sorted.filter((route, index) => sorted[index - 1]?.pattern !== route.pattern);
}

/**
 * Reads the Next.js project at `root` and returns every route its files
 * declare, in Next syntax, sorted and deduplicated by pattern (the first file
 * by path wins). Handles the App Router (`app/` or `src/app/`) and the Pages
 * Router (`pages/` or `src/pages/`) side by side; returns `[]` when neither
 * directory exists.
 */
export async function discoverNextRoutes(root: string): Promise<RouteInfo[]> {
  const [appRoutes, pagesRoutes] = await Promise.all([
    discoverRoutes(root, APP_DIRECTORIES, isSkippedAppDirectory, appRouteFromFile),
    discoverRoutes(root, PAGES_DIRECTORIES, isSkippedPagesDirectory, pagesRouteFromFile),
  ]);
  return sortAndDeduplicate([...appRoutes, ...pagesRoutes]);
}

// One capturing group, so splitting on it alternates literal text (even
// indexes) and dynamic tokens (odd indexes). The optional catch-all takes its
// preceding slash with it, because it may match nothing at all.
const DYNAMIC_TOKEN = /(\/?\[\[\.\.\.[^/\]]+\]\]|\[\.\.\.[^/\]]+\]|\[[^/\]]+\])/;
const REGEX_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

function isDynamicPattern(pattern: string): boolean {
  return DYNAMIC_TOKEN.test(pattern);
}

function escapeRegExp(text: string): string {
  return text.replace(REGEX_SPECIAL_CHARACTERS, '\\$&');
}

function dynamicTokenSource(token: string): string {
  if (token.endsWith(']]')) return '(?:/.*)?';
  if (token.startsWith('[...')) return '.+';
  return '[^/]+';
}

function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(DYNAMIC_TOKEN)
    .map((part, index) => (index % 2 === 0 ? escapeRegExp(part) : dynamicTokenSource(part)))
    .join('');
  return new RegExp(`^${source}$`);
}

function stripTrailingSlashes(pathname: string): string {
  const stripped = pathname.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * Finds the route that serves `pathname` (path only: no query or hash). A
 * trailing slash is ignored. Static patterns win over dynamic ones; among
 * dynamic patterns the longest is tried first. `null` when nothing matches.
 */
export function matchRoute(pathname: string, routes: readonly RouteInfo[]): RouteInfo | null {
  const path = stripTrailingSlashes(pathname);

  const staticMatch = routes.find((route) => route.pattern === path && !isDynamicPattern(route.pattern));
  if (staticMatch !== undefined) return staticMatch;

  const dynamicRoutes = routes
    .filter((route) => isDynamicPattern(route.pattern))
    .toSorted((a, b) => b.pattern.length - a.pattern.length);
  return dynamicRoutes.find((route) => patternToRegExp(route.pattern).test(path)) ?? null;
}

const PARAM_PLACEHOLDER = '[param]';
const MIN_OPAQUE_ID_LENGTH = 20;
const ID_SEGMENT_PATTERNS: readonly RegExp[] = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  new RegExp(`^[A-Za-z0-9_-]{${MIN_OPAQUE_ID_LENGTH},}$`),
];

/**
 * Fallback route pattern for a URL path when no filesystem route matches:
 * numeric, UUID and long opaque-id segments become `[param]`, everything else
 * is kept, so `/orders/12` and `/orders/13` share the pattern `/orders/[param]`.
 */
export function routePatternFromPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) =>
      ID_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)) ? PARAM_PLACEHOLDER : segment,
    )
    .join('/');
}
