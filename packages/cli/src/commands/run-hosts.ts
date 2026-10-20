import { LookoverError, normaliseHost, type RunEvent } from '@jayslifecode/lookover-core';

type HostKind = Extract<RunEvent, { type: 'host.observed' }>['kind'];

/** What the app used each host for so far, by normalised host, from the run's `host.observed` events. */
export type HostKinds = ReadonlyMap<string, ReadonlySet<HostKind>>;

/** Shown after a host the app only loaded static assets from: a CDN or font host belongs in allowHosts. */
export const STATIC_ASSETS_NOTE = '(static assets — consider allowHosts)';

const HOST_KIND_SUBRESOURCE: HostKind = 'subresource';

/** `kinds` with what `event` says about its host added; a new map, `kinds` is not changed. */
export function withObservedHost(kinds: HostKinds, event: RunEvent): HostKinds {
  if (event.type !== 'host.observed') {
    return kinds;
  }
  const host = normaliseHost(event.host);
  return new Map([...kinds, [host, new Set([...(kinds.get(host) ?? []), event.kind])]]);
}

/** True when every request the app sent to `host` loaded a subresource (image, script, style, font, media). */
export function isStaticAssetHost(host: string, kinds: HostKinds): boolean {
  const seen = kinds.get(normaliseHost(host));
  return seen !== undefined && [...seen].every((kind) => kind === HOST_KIND_SUBRESOURCE);
}

/** `host` as the CLI lists it: followed by `STATIC_ASSETS_NOTE` when the app only loaded static assets from it. */
export function hostLabel(host: string, kinds: HostKinds): string {
  return isStaticAssetHost(host, kinds) ? `${host} ${STATIC_ASSETS_NOTE}` : host;
}

/**
 * The engine's `E_HOSTS_UNCONFIRMED` (a heading, then one indented host per line) with each host shown
 * as `label` shows it; a new error with the same code and hint. Any other error is returned as it is.
 */
export function labelUnconfirmedHosts(error: unknown, label: (host: string) => string): unknown {
  if (!(error instanceof LookoverError) || error.code !== 'E_HOSTS_UNCONFIRMED') {
    return error;
  }
  const [heading = '', ...hostLines] = error.message.split('\n');
  const labelled = hostLines.map((line) => {
    const host = line.trim();
    return host === '' ? line : line.replace(host, label(host));
  });
  return new LookoverError(error.code, [heading, ...labelled].join('\n'), error.hint);
}
