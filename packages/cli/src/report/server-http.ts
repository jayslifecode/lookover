import { readFile } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { isMissingFile, redact } from '@jayslifecode/lookover-core';
import type { ApiErrorBody } from '@jayslifecode/lookover-report/api';

/*
 * What every part of the report server answers with: the headers each response carries, JSON, files,
 * the errors a request can end in, and the request body read with its cap.
 */

/** The report loads only from its own origin, and no other page may frame it. No CORS header is ever sent. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  // The build inlines the smallest font subsets into its CSS as `data:` URIs (Vite's asset inline
  // limit): still the report's own bytes, loaded from nowhere.
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const SECURITY_HEADERS: Readonly<OutgoingHttpHeaders> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // Other ports of 127.0.0.1 are the same site, so the cookie rides along: no page of theirs may embed
  // what this server answers (an evidence screenshot in an <img>, say).
  'cross-origin-resource-policy': 'same-origin',
};

export const NO_STORE = 'no-store';
/** The hashed assets never change under their name. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Evidence never changes under its name either, but it is the run's, behind the token: no shared cache. */
export const PRIVATE_IMMUTABLE = 'private, max-age=31536000, immutable';
export const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
/** What a file of no type the server knows is served as: bytes to save, never a page to render. */
export const OCTET_STREAM = 'application/octet-stream';
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': JSON_TYPE,
  '.map': JSON_TYPE,
};

/** A JSON body larger than this is refused (413) before it is parsed. */
export const MAX_BODY_BYTES = 16 * 1024;

/** A request that ends in `status`, with a message the client may show. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? OCTET_STREAM;
}

/** Writes the response with the security headers, `Cache-Control: no-store` unless `headers` says otherwise. */
export function send(
  res: ServerResponse,
  status: number,
  headers: Readonly<OutgoingHttpHeaders>,
  body?: string | Buffer,
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'cache-control': NO_STORE, ...headers });
  res.end(body);
}

/** The headers of an event stream: the security headers, and `no-store`. */
export function streamHeaders(headers: Readonly<OutgoingHttpHeaders>): OutgoingHttpHeaders {
  return { ...SECURITY_HEADERS, 'cache-control': NO_STORE, ...headers };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, { 'content-type': JSON_TYPE }, JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message } satisfies ApiErrorBody);
}

/** A plain-text answer, for the pages of the report that are not there. */
export function sendText(res: ServerResponse, status: number, message: string): void {
  send(res, status, { 'content-type': TEXT_TYPE }, message);
}

/** How `sendFile` answers: its cache policy, its content type, and what a 404 for it says. */
export interface FileAnswer {
  readonly cacheControl?: string;
  /** Default: by the file's extension (`contentTypeOf`). */
  readonly contentType?: string;
  readonly missing?: string;
}

/** The file at `path`; a 404 `HttpError` when there is no file there (a directory is none either). */
export async function sendFile(res: ServerResponse, path: string, answer: FileAnswer = {}): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(path);
  } catch (error) {
    if (isMissingFile(error) || isDirectoryError(error)) {
      throw new HttpError(404, answer.missing ?? 'No such file');
    }
    throw error;
  }
  send(
    res,
    200,
    {
      'content-type': answer.contentType ?? contentTypeOf(path),
      'cache-control': answer.cacheControl ?? NO_STORE,
    },
    body,
  );
}

/** The first line of what `error` says, redacted: what a 500 tells the client, never a stack. */
export function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.split('\n')[0] ?? '').trim() || 'The report server failed';
}

/**
 * The request's body parsed as JSON: a 413 `HttpError` past `MAX_BODY_BYTES` (by its `Content-Length`,
 * or as it arrives), a 400 when it is not JSON.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not JSON');
  }
}

function isDirectoryError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EISDIR';
}

function tooLarge(): HttpError {
  return new HttpError(413, `The body is over ${MAX_BODY_BYTES} bytes`);
}

/** A segment that would step out of the directory a path is resolved in, or name none of its files. */
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..']);
/** What a decoded segment must not hold: a separator (an encoded `/` or `\`) or a NUL. */
const UNSAFE_CHARACTERS = /[/\\\0]/;

/**
 * The segments of the raw request path `rest` (after the prefix it was routed by), each decoded; `null`
 * when one is empty, `.` or `..` (as written or encoded), holds an encoded separator, or does not decode.
 */
export function safeSegments(rest: string): string[] | null {
  const segments = rest.split('/').map(decodeSegment);
  return segments.every((segment): segment is string => segment !== null) ? segments : null;
}

function decodeSegment(raw: string): string | null {
  let segment: string;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return UNSAFE_SEGMENTS.has(segment) || UNSAFE_CHARACTERS.test(segment) ? null : segment;
}
