import { LookoverError, type RunEvent } from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import {
  type HostKinds,
  hostLabel,
  isStaticAssetHost,
  labelUnconfirmedHosts,
  STATIC_ASSETS_NOTE,
  withObservedHost,
} from '../src/commands/run-hosts.js';
import { blockedHostsWarning } from '../src/commands/run-summary.js';

type HostKind = Extract<RunEvent, { type: 'host.observed' }>['kind'];

let seq = 0;

function observed(host: string, kind: HostKind): RunEvent {
  seq += 1;
  return { type: 'host.observed', host, kind, seq, at: '2026-10-21T00:00:00.000Z', runId: 'run-1' };
}

function kindsOf(...events: RunEvent[]): HostKinds {
  return events.reduce(withObservedHost, new Map());
}

/** What the engine throws when hosts are left unconfirmed: a heading, then one indented host per line. */
function unconfirmed(...hosts: string[]): LookoverError {
  return new LookoverError(
    'E_HOSTS_UNCONFIRMED',
    [
      'The app called these backends, and none of them is confirmed as a development or disposable instance:',
      ...hosts.map((host) => `  ${host}`),
    ].join('\n'),
    `Run: lookover run ${hosts.map((host) => `--confirm-host ${host}`).join(' ')}`,
  );
}

describe('host kinds', () => {
  test('collects every kind a host was seen with, without changing the earlier map', () => {
    const before = kindsOf(observed('cdn.example.com', 'subresource'));

    const after = withObservedHost(before, observed('cdn.example.com', 'app-call'));

    expect([...(before.get('cdn.example.com') ?? [])]).toEqual(['subresource']);
    expect([...(after.get('cdn.example.com') ?? [])]).toEqual(['subresource', 'app-call']);
  });

  test('ignores every other event', () => {
    const kinds = kindsOf(observed('a.test', 'app-call'));
    const blocked: RunEvent = {
      type: 'request.blocked',
      url: 'https://a.test/pay',
      reason: 'provider',
      seq: 99,
      at: '2026-10-21T00:00:00.000Z',
      runId: 'run-1',
    };

    expect(withObservedHost(kinds, blocked)).toBe(kinds);
  });

  test('a host is static assets only when every request to it loaded a subresource', () => {
    const kinds = kindsOf(
      observed('fonts.gstatic.com', 'subresource'),
      observed('api.dev.example.com', 'app-call'),
      observed('mixed.example.com', 'subresource'),
      observed('mixed.example.com', 'app-call'),
    );

    expect(isStaticAssetHost('fonts.gstatic.com', kinds)).toBe(true);
    expect(isStaticAssetHost('FONTS.gstatic.com.', kinds)).toBe(true);
    expect(isStaticAssetHost('api.dev.example.com', kinds)).toBe(false);
    expect(isStaticAssetHost('mixed.example.com', kinds)).toBe(false);
    expect(isStaticAssetHost('never.example.com', kinds)).toBe(false);
  });
});

describe('host labels', () => {
  const kinds = kindsOf(
    observed('cdn.example.com', 'subresource'),
    observed('api.dev.example.com', 'app-call'),
  );
  const label = (host: string): string => hostLabel(host, kinds);

  test('mark a host the app only loaded static assets from, and leave the rest alone', () => {
    expect(STATIC_ASSETS_NOTE).toBe('(static assets — consider allowHosts)');
    expect(label('cdn.example.com')).toBe('cdn.example.com (static assets — consider allowHosts)');
    expect(label('api.dev.example.com')).toBe('api.dev.example.com');
  });

  test('label the hosts of E_HOSTS_UNCONFIRMED, keeping its heading, code and hint', () => {
    const error = unconfirmed('api.dev.example.com', 'cdn.example.com');

    const labelled = labelUnconfirmedHosts(error, label);

    expect(labelled).toBeInstanceOf(LookoverError);
    expect(labelled).not.toBe(error);
    expect((labelled as LookoverError).message.split('\n')).toEqual([
      error.message.split('\n')[0],
      '  api.dev.example.com',
      '  cdn.example.com (static assets — consider allowHosts)',
    ]);
    expect(labelled).toMatchObject({ code: 'E_HOSTS_UNCONFIRMED', hint: error.hint });
    expect(error.message).not.toContain(STATIC_ASSETS_NOTE);
  });

  test('pass every other error through as it is', () => {
    const other = new LookoverError('E_AUTH_FAILED', 'cdn.example.com');
    const plain = new Error('boom');

    expect(labelUnconfirmedHosts(other, label)).toBe(other);
    expect(labelUnconfirmedHosts(plain, label)).toBe(plain);
  });

  test('label the hosts of the blocked-backends warning, but not the command', () => {
    const warning = blockedHostsWarning(['api.dev.example.com', 'cdn.example.com'], label);

    expect(warning).toContain(
      'not confirmed: api.dev.example.com, cdn.example.com (static assets — consider allowHosts).',
    );
    expect(warning).toContain(
      'run: lookover run --confirm-host api.dev.example.com --confirm-host cdn.example.com',
    );
  });
});
