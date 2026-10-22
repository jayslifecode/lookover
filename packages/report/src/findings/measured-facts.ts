import type { Finding } from '@jayslifecode/lookover-core';
import { useEffect, useState } from 'react';
import { evidenceUrl, fetchJson } from '@/data/api';

/*
 * The facts a lens measured for a finding, read from its `measurements` evidence file (a flat JSON
 * object) as `key: value` lines. Each file is fetched once per page and shared by every reader (the
 * panel and the copy that grows into it), and a file that fails is asked for again next time.
 */

export const MAX_FACT_LINES = 12;
const MAX_VALUE_LENGTH = 80;

export type MeasuredFacts =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly lines: readonly string[]; readonly more: number }
  | { readonly status: 'failed' };

type Settled = Extract<MeasuredFacts, { status: 'loaded' | 'failed' }>;

const NONE: MeasuredFacts = { status: 'none' };
const LOADING: MeasuredFacts = { status: 'loading' };
const FAILED: Settled = { status: 'failed' };
const loads = new Map<string, Promise<readonly string[]>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = JSON.stringify(value) ?? String(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

/** The file's facts as lines; it is page data, so its shape is checked. */
function factLines(body: unknown): string[] {
  if (!isRecord(body)) throw new Error('The measurements file is not a JSON object');
  return Object.entries(body).map(([key, value]) => `${key}: ${valueText(value)}`);
}

function load(url: string): Promise<readonly string[]> {
  const known = loads.get(url);
  if (known !== undefined) return known;
  const loading = fetchJson(url).then(factLines);
  loads.set(url, loading);
  loading.catch(() => loads.delete(url));
  return loading;
}

function measurementsUrl(finding: Finding): string | null {
  const item = finding.evidence.find((evidence) => evidence.kind === 'measurements');
  return item === undefined ? null : evidenceUrl(item.ref);
}

/** The first `MAX_FACT_LINES` facts of `finding`'s measurements, and how many more there are. */
export function useMeasuredFacts(finding: Finding): MeasuredFacts {
  const url = measurementsUrl(finding);
  const [settled, setSettled] = useState<{ readonly url: string; readonly facts: Settled } | null>(null);

  useEffect(() => {
    if (url === null) return;
    let isCurrent = true;
    load(url).then(
      (lines) => {
        if (!isCurrent) return;
        const facts: Settled = {
          status: 'loaded',
          lines: lines.slice(0, MAX_FACT_LINES),
          more: Math.max(lines.length - MAX_FACT_LINES, 0),
        };
        setSettled({ url, facts });
      },
      () => {
        if (isCurrent) setSettled({ url, facts: FAILED });
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [url]);

  if (url === null) return NONE;
  return settled?.url === url ? settled.facts : LOADING;
}
