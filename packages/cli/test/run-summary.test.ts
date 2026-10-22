import type { Finding, JudgeTotals } from '@jayslifecode/lookover-core';
import { describe, expect, test } from 'vitest';
import {
  blockedHostsWarning,
  CANDIDATES_NOTE,
  findingsNote,
  formatDuration,
  HARNESS_ONLY_NOTE,
  judgeSummary,
  progressLine,
  summaryRows,
} from '../src/commands/run-summary.js';
import {
  appMap,
  element,
  findingsFile,
  form,
  HARNESS_ONLY,
  judged,
  judgedFile,
  screen,
  stepCandidate,
} from './run-fixtures.js';

/** What a run that asked the judge model cost, as the brief's example. */
const MODEL_TOTALS: JudgeTotals = {
  model: 'claude-sonnet-5-5',
  calls: 34,
  cacheHits: 3,
  usage: { input: 48_000, output: 9_000, cacheRead: 4_000, cacheWrite: 204 },
  estimatedUsd: 0.1903,
  unavailable: null,
};

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
    const skipped = [
      { reason: 'time-budget', count: 12 },
      { reason: 'focus-indicator-ua-ring', count: 9 },
      { reason: 'background-uncertain:overlapped', count: 4 },
      { reason: 'gone', count: 1 },
    ];
    const inspected = {
      ...summary,
      inspection: {
        findings: findingsFile(candidates(3), candidates(2, 3), skipped),
        findingsPath: '/work/app/.lookover/findings.json',
      },
    };

    test('in a --no-judge run, adds the candidates, the worth-a-look entries, the skips, the judge and the findings file', () => {
      const rows = summaryRows(inspected);

      expect(rows.slice(0, 8)).toEqual(summaryRows(summary));
      expect(rows.slice(8)).toEqual([
        ['Candidates', '3'],
        ['Worth a look', '2'],
        ['Skipped', 'time-budget 12 · focus-indicator-ua-ring 9 · background-uncertain:overlapped 4'],
        ['Judge', 'off (--no-judge)'],
        ['Findings', '.lookover/findings.json'],
      ]);
    });

    test('in a judged run, counts the confirmed, rejected and intended findings, then the rest and the judge', () => {
      const file = judgedFile({
        findings: candidates(4).map((finding) => judged(finding)),
        rejected: candidates(2, 4).map((finding) => judged(finding, { status: 'rejected', reproduced: 1 })),
        intended: [
          { ...stepCandidate({ ruleId: 'interaction.target-size', selector: '#i' }), status: 'intended' },
        ],
        worthALook: candidates(5, 6),
        skipped: skipped.slice(3),
      });

      const rows = summaryRows({ ...inspected, inspection: { ...inspected.inspection, findings: file } });

      expect(rows.slice(0, 8)).toEqual(summaryRows(summary));
      expect(rows.slice(8)).toEqual([
        ['Confirmed', '4'],
        ['Rejected', '2'],
        ['Intended', '1'],
        ['Worth a look', '5'],
        ['Skipped', 'gone 1'],
        ['Judge', 'harness only (no ANTHROPIC_API_KEY)'],
        ['Findings', '.lookover/findings.json'],
      ]);
    });

    test('in a judged run, a candidate the judge never decided on does not count as confirmed', () => {
      const file = judgedFile({ findings: [judged(candidates(1)[0] as Finding), ...candidates(1, 1)] });

      const rows = summaryRows({ ...inspected, inspection: { ...inspected.inspection, findings: file } });

      expect(rows).toContainEqual(['Confirmed', '1']);
    });

    test('in a judged run, shows what the judge model cost', () => {
      const file = judgedFile({ judge: MODEL_TOTALS });

      const rows = summaryRows({ ...inspected, inspection: { ...inspected.inspection, findings: file } });

      expect(rows).toContainEqual([
        'Judge',
        'claude-sonnet-5-5 · 34 calls (3 cached) · 61,204 tokens · ≈ $0.19',
      ]);
    });

    test('lists every reason when there are three or fewer, in the order the file keeps them', () => {
      const few = { ...inspected.inspection, findings: findingsFile([], [], skipped.slice(2)) };

      expect(summaryRows({ ...inspected, inspection: few })).toContainEqual([
        'Skipped',
        'background-uncertain:overlapped 4 · gone 1',
      ]);
    });

    test('says none when nothing was skipped, or the file predates the tally', () => {
      for (const tally of [[], undefined]) {
        const clean = { ...inspected.inspection, findings: findingsFile([], [], tally) };

        expect(summaryRows({ ...inspected, inspection: clean })).toContainEqual(['Skipped', 'none']);
      }
    });

    test('has no Skipped row for a --map-only run', () => {
      expect(summaryRows(summary).map(([label]) => label)).not.toContain('Skipped');
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

describe('HARNESS_ONLY_NOTE', () => {
  test('says the findings were reproduced but not reviewed by the model, and how to turn it on', () => {
    expect(HARNESS_ONLY_NOTE).toBe(
      'Findings were reproduced 3 times each but not reviewed by the judge model; set ANTHROPIC_API_KEY to enable it.',
    );
  });
});

describe('judgeSummary', () => {
  test('names the model, its calls and cache hits, the tokens and the estimated cost', () => {
    expect(judgeSummary(MODEL_TOTALS)).toBe(
      'claude-sonnet-5-5 · 34 calls (3 cached) · 61,204 tokens · ≈ $0.19',
    );
  });

  test('uses the singular for one call', () => {
    const one: JudgeTotals = {
      ...MODEL_TOTALS,
      calls: 1,
      cacheHits: 0,
      usage: { input: 900, output: 99, cacheRead: 0, cacheWrite: 0 },
      estimatedUsd: 0.0028,
    };

    expect(judgeSummary(one)).toBe('claude-sonnet-5-5 · 1 call (0 cached) · 999 tokens · ≈ $0.00');
  });

  test('says the cost is unknown for a model the price table does not know', () => {
    expect(judgeSummary({ ...MODEL_TOTALS, model: 'claude-next', estimatedUsd: null })).toBe(
      'claude-next · 34 calls (3 cached) · 61,204 tokens · cost unknown',
    );
  });

  test('says so when the model stopped answering during the run', () => {
    expect(judgeSummary({ ...MODEL_TOTALS, unavailable: 'api-error' })).toBe(
      'claude-sonnet-5-5 · 34 calls (3 cached) · 61,204 tokens · ≈ $0.19 · stopped after an API error',
    );
  });

  test('says the harness decided alone when there was no API key', () => {
    expect(judgeSummary(HARNESS_ONLY)).toBe('harness only (no ANTHROPIC_API_KEY)');
  });

  test('says the judge was off for a run that was not judged', () => {
    expect(judgeSummary(null)).toBe('off (--no-judge)');
  });
});

describe('findingsNote', () => {
  test('is the candidates note for a run that was not judged', () => {
    expect(findingsNote(null)).toBe(CANDIDATES_NOTE);
  });

  test('is the harness-only note when the harness decided alone for want of a key', () => {
    expect(findingsNote(HARNESS_ONLY)).toBe(HARNESS_ONLY_NOTE);
  });

  test('is nothing when the judge model reviewed the findings', () => {
    expect(findingsNote(MODEL_TOTALS)).toBeNull();
    expect(findingsNote({ ...MODEL_TOTALS, unavailable: 'api-error' })).toBeNull();
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
