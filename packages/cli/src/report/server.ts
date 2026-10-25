import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Finding, type Lens, type LookoverConfig, LookoverError } from '@jayslifecode/lookover-core';
import { DEFAULT_REPLAY_TIMES, runReplay } from '@jayslifecode/lookover-judge';
import { TOKEN_QUERY } from '@jayslifecode/lookover-report/api';
import { type ApiHandler, createApi, type ReplayFinding } from './server-api.js';
import { hasToken, isOwnHost, isSameOrigin } from './server-auth.js';
import { firstLineOf, HttpError, sendError, sendText } from './server-http.js';
import { serveStatic } from './server-static.js';
import { newToken } from './token.js';

export type { ReplayFinding } from './server-api.js';

/*
 * The live report of one run, served on the loopback interface only, on a port of its own: the built
 * report (`server-static.ts`), and the API it reads (`server-api.ts`) behind the run's token
 * (`server-auth.ts`). Nothing in it asks for anything beyond this machine, and nothing but a page that
 * holds the token can read the run or write a decision.
 */

/** The only address the server listens on: nothing off this machine can reach it. */
export const LOOPBACK_HOST = '127.0.0.1';
const API_PREFIX = '/api/';
const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'POST']);
const MISDIRECTED = 'This is the Lookover report server: address it as 127.0.0.1 or localhost';
const NO_TOKEN = "This needs the report's token: open the URL lookover printed";
const CROSS_ORIGIN = 'A write must come from the report itself';

export interface ReportServerOptions {
  readonly lookoverDir: string;
  readonly runId: string;
  /** The project directory: a replay resolves the config's storage state path against it. */
  readonly cwd: string;
  readonly config: LookoverConfig;
  /** The lenses a replay measures a finding with: the one that reported it. */
  readonly lenses: readonly Lens[];
  /** Shown by the report, and recorded in a replay's environment. */
  readonly lookoverVersion: string;
  /** Default 0: a free port the system picks. */
  readonly port?: number;
  readonly host?: typeof LOOPBACK_HOST;
  /** Whether a replay shows its browser window (default `true`: the user asked to watch it). */
  readonly headed?: boolean;
  /** What `POST /api/replay` runs; default `runReplay` with the options above, as `lookover replay` does. */
  readonly replay?: ReplayFinding;
}

export interface ReportServer {
  /** The URL to open: the report, with the token that lets it in. */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Stops listening and ends every open connection, the event streams included. */
  close(): Promise<void>;
}

/** The parts of a request that decide where it goes. */
interface Gate {
  readonly token: string;
  /** Where the server listens (`port` 0 and `origin` empty until it does). */
  readonly address: () => { readonly port: number; readonly origin: string };
  readonly api: ApiHandler;
}

export async function startReportServer(options: ReportServerOptions): Promise<ReportServer> {
  const host = options.host ?? LOOPBACK_HOST;
  const token = newToken();
  const api = createApi({
    lookoverDir: options.lookoverDir,
    runId: options.runId,
    lookoverVersion: options.lookoverVersion,
    baseUrl: options.config.baseUrl,
    startedAt: new Date().toISOString(),
    replay: options.replay ?? defaultReplay(options),
  });
  let address = { port: 0, origin: '' };
  const gate: Gate = { token, address: () => address, api };
  const server = createServer((req, res) => {
    route(req, res, gate).catch((error: unknown) => answerFailure(req, res, error));
  });
  const port = await listen(server, options.port ?? 0, host);
  address = { port, origin: `http://${host}:${port}` };
  return { url: `${address.origin}/?${TOKEN_QUERY}=${token}`, port, token, close: closer(server) };
}

/**
 * A request addressed by another name is a 421 before anything else, static files included; then the
 * method (405), the token for `/api/*` (401), and a same-origin `Origin` for a POST (403).
 */
async function route(req: IncomingMessage, res: ServerResponse, gate: Gate): Promise<void> {
  const { port, origin } = gate.address();
  if (!isOwnHost(req, port)) throw new HttpError(421, MISDIRECTED);
  const method = req.method ?? '';
  if (!ALLOWED_METHODS.has(method)) throw new HttpError(405, `The report server does not answer ${method}`);
  const { path, query } = splitTarget(req.url ?? '/');
  if (!path.startsWith(API_PREFIX)) {
    if (method !== 'GET') throw new HttpError(405, 'The report itself answers GET only');
    return serveStatic(res, path, query, { token: gate.token, port });
  }
  if (!hasToken(req, gate.token, port)) throw new HttpError(401, NO_TOKEN);
  if (method === 'POST' && !isSameOrigin(req, origin)) throw new HttpError(403, CROSS_ORIGIN);
  return gate.api(req, res, path);
}

/** The request target's path, as sent (still encoded, dots and all), and its query without the `?`. */
function splitTarget(target: string): { path: string; query: string } {
  const at = target.indexOf('?');
  return at === -1 ? { path: target, query: '' } : { path: target.slice(0, at), query: target.slice(at + 1) };
}

/** An `HttpError` answers its status; anything else is a 500 with the first line of its message, redacted. */
function answerFailure(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : firstLineOf(error);
  if ((req.url ?? '').startsWith(API_PREFIX)) sendError(res, status, message);
  else sendText(res, status, message);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** `close`, once however often it is called: open connections (event streams) are ended, not waited for. */
function closer(server: Server): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeAllConnections();
    });
    return closing;
  };
}

/** `runReplay` in a browser of its own, headed unless `headed` is `false`, once, as `lookover replay` does. */
function defaultReplay(options: ReportServerOptions): ReplayFinding {
  return async (finding) =>
    runReplay({
      cwd: options.cwd,
      config: options.config,
      finding,
      lenses: lensesFor(finding, options.lenses),
      lookoverVersion: options.lookoverVersion,
      times: DEFAULT_REPLAY_TIMES,
      headless: options.headed === false,
      env: process.env,
    });
}

/** The lens that reported `finding`; an observer finding is measured by the observers alone. */
function lensesFor(finding: Finding, lenses: readonly Lens[]): Lens[] {
  if (finding.source === 'observers') return [];
  const lens = lenses.find(({ name }) => name === finding.source);
  if (lens === undefined) {
    throw new LookoverError(
      'E_USAGE',
      `The report has no ${finding.source} lens to replay ${finding.id} with`,
    );
  }
  return [lens];
}
