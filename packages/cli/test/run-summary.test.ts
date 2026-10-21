import type { Finding } from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import {
  blockedHostsWarning,
  CANDIDATES_NOTE,
  formatDuration,
  progressLine,
  summaryRows,
} from '../src/commands/run-summary.js';
import { appMap, element, findingsFile, form, screen, stepCandidate } from './run-fixtures.js';

/** `count` distinct candidates, numbered from `first`; what they are does not matter to a count. */
function candidates(count: number, first = 0): Finding[] {
  return Array.from({ length: count }, (_, index) =>
    stepCandidate({ ruleId: 'interaction.target-size', selector: `#t${first + index}` }),
  );
}

describe('progressLine', () => {
  test('names the route with its element and form counts', () => {
    const edit = screen({
      route: '/organisations/[id]',
      elements: Array.from({ length: 18 }, (_, index) => element(`e${index}`)),
      forms: [form('form')],
    });

    expect(progressLine(edit)).toBe('✓ /organisations/[id]  18 elements · 1 form');
  });

  test('uses the singular for one element and the plural for no forms', () => {
    expect(progressLine(screen({ elements: [element('only')] }))).toBe('✓ /  1 element · 0 forms');
  });

  test('shows where a redirected screen landed, after the path that was requested', () => {
    const redirected = screen({
      url: 'http://localhost:3000/home.html?tab=2',
      route: '/home.html',
      redirectedFrom: 'http://localhost:3000/',
      elements: [element('a'), element('b'), element('c')],
    });

    expect(progressLine(redirected)).toBe('✓ /  → /home.html  3 elements · 0 forms');
  });

  test('adds the candidate count when the screen was inspected', () => {
    const edit = screen({
      route: '/organisations/[id]',
      elements: Array.from({ length: 12 }, (_, index) => element(`e${index}`)),
      forms: [form('form')],
    });

    expect(progressLine(edit, 2)).toBe('✓ /organisations/[id]  12 elements · 1 form · 2 candidates');
  });

  test('uses the singular for one candidate and says 0 candidates for none', () => {
    expect(progressLine(screen(), 1)).toBe('✓ /  0 elements · 0 forms · 1 candidate');
    expect(progressLine(screen(), 0)).toBe('✓ /  0 elements · 0 forms · 0 candidates');
  });

  test('puts the candidate count after where a redirected screen landed', () => {
    const redirected = screen({
      url: 'http://localhost:3000/home.html',
      route: '/home.html',
      redirectedFrom: 'http://localhost:3000/',
    });

    expect(progressLine(redirected, 3)).toBe('✓ /  → /home.html  0 elements · 0 forms · 3 candidates');
  });

  test('flags a screen whose navigation failed', () => {
    const failed = screen({
      route: '/reports',
      title: '(navigation failed: net::ERR_ABORTED)',
      status: 'navigation-failed',
      error: 'net::ERR_ABORTED',
    });

    expect(progressLine(failed)).toBe('! /reports  navigation failed');
  });

  test('shows no candidate count for a screen whose navigation failed', () => {
    const failed = screen({ route: '/reports', status: 'navigation-failed', error: 'net::ERR_ABORTED' });

    expect(progressLine(failed, 0)).toBe('! /reports  navigation failed');
  });

  test('goes by the status, not the title', () => {
    const titledLikeAFailure = screen({ route: '/help', title: '(navigation failed: how to fix it)' });

    expect(progressLine(titledLikeAFailure)).toBe('✓ /help  0 elements · 0 forms');
  });
});

describe('summaryRows', () => {
  const summary = {
    cwd: '/work/app',
    map: appMap([
      screen({ elements: [element('a'), element('b')], forms: [form('f1')] }),
      screen({ elements: [element('c')], forms: [form('f2'), form('f3')] }),
    ]),
    confirmedBackendHosts: ['api.dev.example.com', 'auth.dev.example.com'],
    blockedRequests: 3,
    runDir: '/work/app/.lookover/runs/20261021-101500-ab12',
    appMapPath: '/work/app/.lookover/app-map.json',
    durationMs: 42_345,
  };

  test('totals the map and shows paths relative to the project', () => {
    expect(summaryRows(summary)).toEqual([
      ['Screens', '2'],
      ['Elements', '3'],
      ['Forms', '3'],
      ['Backend hosts', 'api.dev.example.com, auth.dev.example.com'],
      ['Blocked requests', '3'],
      ['Run dir', '.lookover/runs/20261021-101500-ab12'],
      ['App map', '.lookover/app-map.json'],
      ['Duration', '42.3 s'],
    ]);
  });

  test('says none when no backend host is confirmed', () => {
    const rows = summaryRows({ ...summary, confirmedBackendHosts: [] });

    expect(rows).toContainEqual(['Backend hosts', 'none']);
  });

  describe('after an inspection', () => {
    const inspected = {
      ...summary,
      inspection: {
        findings: findingsFile(candidates(3), candidates(2, 3)),
        findingsPath: '/work/app/.lookover/runs/20261021-101500-ab12/findings.json',
      },
    };

    test('adds the candidates, the worth-a-look entries and the findings file after the other rows', () => {
      const rows = summaryRows(inspected);

      expect(rows.slice(0, 8)).toEqual(summaryRows(summary));
      expect(rows.slice(8)).toEqual([
        ['Candidates', '3'],
        ['Worth a look', '2'],
        ['Findings', '.lookover/runs/20261021-101500-ab12/findings.json'],
      ]);
    });

    test('reports zero candidates as 0', () => {
      const clean = { ...inspected, inspection: { ...inspected.inspection, findings: findingsFile([]) } };

      expect(summaryRows(clean).slice(8)).toContainEqual(['Candidates', '0']);
      expect(summaryRows(clean).slice(8)).toContainEqual(['Worth a look', '0']);
    });
  });
});

describe('CANDIDATES_NOTE', () => {
  test('says the candidates are measured, not judged or reproduced', () => {
    expect(CANDIDATES_NOTE).toBe(
      'Candidates are measured but not yet judged or reproduced; the judge arrives in the next release.',
    );
  });
});

describe('formatDuration', () => {
  test.each([
    [1_234, '1.2 s'],
    [59_940, '59.9 s'],
    [59_960, '1 min 0 s'],
    [125_400, '2 min 5 s'],
  ])('%d ms is %o', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('blockedHostsWarning', () => {
  test('names the blocked hosts and the command that confirms them', () => {
    const warning = blockedHostsWarning(['a.dev.test', 'b.dev.test']);

    expect(warning).toContain('a.dev.test, b.dev.test');
    expect(warning).toContain('lookover run --confirm-host a.dev.test --confirm-host b.dev.test');
  });
});
