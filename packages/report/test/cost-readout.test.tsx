import type { JudgeTotals } from '@jayslifecode/lookover-core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { CostReadout, costText, formatTokens } from '../src/shell/cost-readout';

/* The top bar's cost readout: what the judge model cost the run, or why it was not used. */

/** 40,100 + 5,200 + 14,900 + 1,000 = 61,200 tokens. */
const USED: JudgeTotals = {
  model: 'claude-sonnet-5-5',
  calls: 34,
  cacheHits: 12,
  usage: { input: 40_100, output: 5_200, cacheRead: 14_900, cacheWrite: 1_000 },
  estimatedUsd: 0.1874,
  unavailable: null,
};
/** The judge model never asked: no model, no calls (as the pipeline totals a run it could not ask). */
const NOT_ASKED: JudgeTotals = {
  model: null,
  calls: 0,
  cacheHits: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  estimatedUsd: null,
  unavailable: null,
};

afterEach(() => {
  cleanup();
});

test('a judged run: its calls, its tokens to the nearest thousand and its estimated cost', () => {
  expect(costText(USED)).toBe('34 calls · 61k tokens · ≈ $0.19');
  expect(costText({ ...USED, calls: 1 })).toBe('1 call · 61k tokens · ≈ $0.19');
  expect(costText({ ...USED, estimatedUsd: null })).toBe('34 calls · 61k tokens · cost unknown');
});

test('a judge model that was not used says why', () => {
  expect(costText(null)).toBe('judge model off');
  expect(costText({ ...NOT_ASKED, unavailable: 'disabled' })).toBe('judge model off');
  expect(costText({ ...NOT_ASKED, unavailable: 'no-api-key' })).toBe('judge model not used (no API key)');
  expect(costText({ ...NOT_ASKED, unavailable: 'api-error' })).toBe('judge model unavailable');
});

test('a judge model that failed partway shows what it cost before it failed, with the breakdown', async () => {
  const partial: JudgeTotals = { ...USED, unavailable: 'api-error' };
  expect(costText(partial)).toBe('34 calls · 61k tokens · ≈ $0.19 · judge model failed partway');

  render(<CostReadout totals={partial} isFinished={true} />);
  fireEvent.focus(screen.getByRole('button', { name: /judge model failed partway$/ }));
  expect(await screen.findByText('34 calls, 12 from the cache')).toBeDefined();
});

test('a run going with the judge turned off says so before it has totals', () => {
  const { container } = render(<CostReadout totals={null} isFinished={false} judgeUnavailable="disabled" />);
  expect(container.textContent).toBe('judge model off');
});

test('tokens are exact under a thousand, and rounded to the nearest thousand from there', () => {
  expect(formatTokens(0)).toBe('0');
  expect(formatTokens(999)).toBe('999');
  expect(formatTokens(1_000)).toBe('1k');
  expect(formatTokens(1_499)).toBe('1k');
  expect(formatTokens(1_500)).toBe('2k');
  expect(formatTokens(61_234)).toBe('61k');
});

test('its tooltip breaks the cost down: the model, the calls and cache hits, and each kind of token', async () => {
  render(<CostReadout totals={USED} isFinished={true} />);

  const readout = screen.getByRole('button', { name: '34 calls · 61k tokens · ≈ $0.19' });
  fireEvent.focus(readout);

  expect(await screen.findByText('claude-sonnet-5-5')).toBeDefined();
  expect(screen.getByText('34 calls, 12 from the cache')).toBeDefined();
  for (const [kind, count] of [
    ['Input', '40,100'],
    ['Output', '5,200'],
    ['Cache read', '14,900'],
    ['Cache write', '1,000'],
  ]) {
    expect(screen.getByText(kind as string, { selector: 'dt' }).nextElementSibling?.textContent).toBe(count);
  }
});

test('a judge model not used is plain text; a run still going, or failed, shows no cost until it has one', () => {
  const { container, rerender } = render(
    <CostReadout totals={{ ...NOT_ASKED, unavailable: 'no-api-key' }} isFinished={true} />,
  );
  expect(screen.getByText('judge model not used (no API key)')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();

  rerender(<CostReadout totals={null} isFinished={false} />);
  expect(container.textContent).toBe('');
  rerender(<CostReadout totals={null} isFinished={true} />);
  expect(container.textContent).toBe('judge model off');
});
