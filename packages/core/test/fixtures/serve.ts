import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

/** Handles one exact pathname instead of the static files (redirects, dynamic responses). */
export type FixtureRoute = (req: IncomingMessage, res: ServerResponse) => void;

export interface FixtureServer {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:53121`. */
  url: string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/** Serves `dir` on an ephemeral port; `routes` take precedence over files for their exact pathname. */
export async function serveFixture(
  dir: string,
  routes: Readonly<Record<string, FixtureRoute>> = {},
): Promise<FixtureServer> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
    const route = routes[pathname];
    if (route) {
      route(req, res);
      return;
    }
    void serveFile(root, pathname, res);
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(EPHEMERAL_PORT, HOST, () => done());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${HOST}:${port}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
        server.closeAllConnections();
      }),
  };
}

async function serveFile(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const file = fileFor(root, pathname);
  const type = file === null ? undefined : CONTENT_TYPES[extname(file)];
  if (file === null || type === undefined) {
    notFound(res);
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    notFound(res);
  }
}

/** The file under `root` for `pathname`, or `null` when it is malformed or escapes `root`. */
function fileFor(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = resolve(root, `.${decoded}`);
  const target = decoded.endsWith('/') ? join(file, 'index.html') : file;
  return target.startsWith(`${root}${sep}`) ? target : null;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}
