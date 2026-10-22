import {
  type Attempt,
  type Environment,
  type EvidenceItem,
  type EvidenceRef,
  type Finding,
  type OccurrenceFinding,
  redact,
  redactDeep,
  type Step,
  type StepFinding,
  sha256,
  type Viewport,
} from '@jayslifecode/lookover-core';
import type { Rule } from '@jayslifecode/lookover-rules';
import { JUDGE_PROMPT_VERSION } from './prompt.js';

/** Characters of measured facts a bundle carries in all; the rest is cut and the text says how much. */
export const MAX_BUNDLE_MEASUREMENT_CHARS = 2_000;
/** Crops of the element a bundle attaches: the one at rest and the one in the rule's state. */
export const MAX_BUNDLE_CROPS = 2;
/** A crop is attached only when the bytes read for it are under this; a larger one is named in the text. */
export const MAX_CROP_BYTES = 200_000;

const UNTRUSTED_OPEN = '<untrusted_page_content>';
const UNTRUSTED_CLOSE = '</untrusted_page_content>';
/** The wrapper's own tags inside page text, in any case: they are escaped so the page cannot close it. */
const WRAPPER_TAG = /<(\/?untrusted_page_content)/gi;
const MEASURED_KINDS: ReadonlySet<EvidenceItem['kind']> = new Set(['measurements', 'styles']);
const CLOSING = 'Give your verdict on this finding.';

/** What the judge model is sent for one finding: the text, the crops, and the key its verdict is cached by. */
export interface JudgeBundle {
  text: string;
  images: { mediaType: 'image/png'; data: string }[];
  hash: string;
}

export interface BundleInput {
  finding: Finding;
  rule: Rule;
  attempts: readonly Attempt[];
  environment: Environment;
  /** The model the bundle is for: its id is part of the hash, so a verdict is cached per model. */
  model: string;
  readEvidence: (ref: EvidenceRef) => Promise<Buffer>;
}

/** What the bundle hash is made of: the prompt version, the model and what the model is shown. */
export interface BundleHashInput {
  promptVersion: number;
  model: string;
  text: string;
  imageIds: readonly string[];
}

interface MeasuredFact {
  label: string;
  /** Already redacted: it is cut to the budget after redaction, never before. */
  content: string;
}

interface AttachedCrop {
  item: EvidenceItem;
  data: Buffer;
}

interface CropChoice {
  attached: AttachedCrop[];
  leftOut: string[];
}

/**
 * The text and crops the judge model is sent for one finding, and their hash. The text has the rule, the
 * finding, its measured facts (cut to `MAX_BUNDLE_MEASUREMENT_CHARS`), which crops are attached, every
 * attempt and the environment. Every string that came from the page is wrapped as untrusted page content;
 * the catalogue's text and Lookover's own words are not. Nothing in it depends on when it was built (no
 * timestamp, no duration), so the same evidence gives the same hash. A failure to read evidence is thrown.
 */
export async function bundleFor(input: BundleInput): Promise<JudgeBundle> {
  const { finding, rule, attempts, environment, model, readEvidence } = input;
  const crops = await chooseCrops(finding.evidence, readEvidence);
  const facts = await measuredFactsOf(finding, readEvidence);
  const images = crops.attached.map(({ data }) => ({
    mediaType: 'image/png' as const,
    data: data.toString('base64'),
  }));
  const text = [
    ruleSection(rule),
    findingSection(finding),
    measuredSection(facts),
    cropSection(crops),
    attemptsSection(attempts),
    environmentSection(environment),
    CLOSING,
  ].join('\n\n');
  const imageIds = crops.attached.map(({ item }) => item.ref.id);
  return { text, images, hash: bundleHash({ promptVersion: JUDGE_PROMPT_VERSION, model, text, imageIds }) };
}

/** The sha256 a verdict is cached under: the same prompt, model, text and crops give the same verdict. */
export function bundleHash({ promptVersion, model, text, imageIds }: BundleHashInput): string {
  return sha256(JSON.stringify([promptVersion, model, text, imageIds]));
}

/** Page text, redacted and wrapped so the model reads it as data. */
function untrusted(text: string): string {
  return wrap(redact(text));
}

/**
 * Text that is already redacted, wrapped so the model reads it as data. The wrapper's own tags inside it
 * are escaped, so the page cannot close the wrapper and speak outside it.
 */
function wrap(redactedText: string): string {
  return `${UNTRUSTED_OPEN}${redactedText.replace(WRAPPER_TAG, '&lt;$1')}${UNTRUSTED_CLOSE}`;
}

function ruleSection(rule: Rule): string {
  const { reference } = rule;
  const source =
    reference === null
      ? 'none (a Lookover rule with no external standard)'
      : `${reference.standard} ${reference.criterion} (${reference.url})`;
  return [
    '## The rule',
    `Id: ${rule.id}`,
    `Title: ${rule.title}`,
    `Severity: ${rule.severity}`,
    `Expected: ${rule.expected}`,
    `Why it matters: ${rule.whyItMatters}`,
    `Fix hint: ${rule.fixHint}`,
    `Standard: ${source}`,
  ].join('\n');
}

function findingSection(finding: Finding): string {
  return finding.shape === 'step' ? stepSection(finding) : occurrenceSection(finding);
}

function stepSection(finding: StepFinding): string {
  const { target, trace } = finding;
  const element =
    target === null
      ? ['Element: not recorded']
      : [
          `Element role: ${untrusted(target.role)}`,
          `Element name: ${untrusted(target.name)}`,
          `Selector: ${untrusted(target.selector)}`,
          `Component: ${target.componentName === null ? 'not known' : untrusted(target.componentName)}`,
          `Class signature: ${target.signature === null ? 'not known' : untrusted(target.signature)}`,
        ];
  return [
    '## The finding: one element on one screen',
    `Route: ${untrusted(trace.route)}`,
    `URL: ${untrusted(trace.url)}`,
    `Viewport: ${viewportText(trace.viewport)}`,
    ...element,
    `Observed: ${untrusted(finding.observed)}`,
    'Steps that reproduce it:',
    ...trace.steps.map((step, index) => `${index + 1}. ${stepText(step)}`),
  ].join('\n');
}

function stepText(step: Step): string {
  switch (step.kind) {
    case 'navigate':
      return `Go to ${untrusted(step.url)}`;
    case 'set-viewport':
      return `Set the viewport to ${viewportText(step.viewport)}`;
    case 'force-state':
      return `Force the ${step.state} state on ${untrusted(step.selector)}`;
    case 'focus':
      return `Focus ${untrusted(step.selector)}`;
    case 'press':
      return `Press ${step.key} ${step.times} ${step.times === 1 ? 'time' : 'times'}`;
    case 'measure':
      return `Measure ${step.what}`;
  }
}

function occurrenceSection(finding: OccurrenceFinding): string {
  const { occurrences } = finding;
  const places = occurrences.map(({ route, url, viewport, selector }, index) => {
    const element = selector === null ? 'no element' : `element ${untrusted(selector)}`;
    return `${index + 1}. Route ${untrusted(route)}, URL ${untrusted(url)}, viewport ${viewportText(viewport)}, ${element}`;
  });
  const count = occurrences.length;
  return [
    `## The finding: one problem seen in ${count} ${count === 1 ? 'place' : 'places'}`,
    `Observed: ${untrusted(finding.observed)}`,
    'Places:',
    ...places,
  ].join('\n');
}

function viewportText({ name, width, height }: Viewport): string {
  return `${name} (${width}x${height})`;
}

/**
 * The occurrences' measured values, then the finding's measurement and style evidence, as compact JSON
 * redacted with `redactDeep` (so a value under a key such as `authorization` goes too). Redacted here,
 * before `measuredSection` cuts them: a secret the cut splits would no longer look like one.
 */
async function measuredFactsOf(
  finding: Finding,
  readEvidence: (ref: EvidenceRef) => Promise<Buffer>,
): Promise<MeasuredFact[]> {
  const fromOccurrences =
    finding.shape === 'occurrence'
      ? finding.occurrences.map(({ measured }, index) => ({
          label: `place ${index + 1}`,
          content: JSON.stringify(redactDeep(measured)),
        }))
      : [];
  const measuredEvidence = finding.evidence.filter(
    ({ kind, ref }) => MEASURED_KINDS.has(kind) && ref.kind === 'json',
  );
  const fromEvidence = await Promise.all(
    measuredEvidence.map(async ({ label, ref }) => ({
      label,
      content: redactedCompactJson((await readEvidence(ref)).toString('utf8')),
    })),
  );
  return [...fromOccurrences, ...fromEvidence];
}

/** The stored JSON, redacted, without its indentation; text that does not parse is redacted as text. */
function redactedCompactJson(text: string): string {
  try {
    return JSON.stringify(redactDeep(JSON.parse(text)));
  } catch {
    return redact(text.trim());
  }
}

function measuredSection(facts: readonly MeasuredFact[]): string {
  if (facts.length === 0) return '## Measured facts\nNone were recorded.';
  const total = facts.reduce((sum, { content }) => sum + content.length, 0);
  const { shown } = facts.reduce<{ shown: MeasuredFact[]; budget: number }>(
    ({ shown: kept, budget }, fact) => {
      const content = fact.content.slice(0, budget);
      return {
        shown: content === '' ? kept : [...kept, { ...fact, content }],
        budget: budget - content.length,
      };
    },
    { shown: [], budget: MAX_BUNDLE_MEASUREMENT_CHARS },
  );
  const leftOut = total - shown.reduce((sum, { content }) => sum + content.length, 0);
  const trimmed =
    leftOut > 0
      ? [
          `The measurements are trimmed to ${MAX_BUNDLE_MEASUREMENT_CHARS} characters; ${leftOut} more were left out.`,
        ]
      : [];
  return [
    '## Measured facts',
    ...shown.map(({ label, content }) => `- ${label}: ${wrap(content)}`),
    ...trimmed,
  ].join('\n');
}

/**
 * The finding's crops in its own order (the rest crop first), at most two, each under the byte limit. The
 * limit is checked on the bytes read, not on the size the ref records, and the crops are read one at a
 * time, only while there is room for another.
 */
async function chooseCrops(
  evidence: readonly EvidenceItem[],
  readEvidence: (ref: EvidenceRef) => Promise<Buffer>,
): Promise<CropChoice> {
  const crops = evidence.filter(({ kind, ref }) => kind === 'crop' && ref.kind === 'png');
  return crops.reduce<Promise<CropChoice>>(
    async (previous, crop) => withCrop(await previous, crop, readEvidence),
    Promise.resolve({ attached: [], leftOut: [] }),
  );
}

async function withCrop(
  { attached, leftOut }: CropChoice,
  crop: EvidenceItem,
  readEvidence: (ref: EvidenceRef) => Promise<Buffer>,
): Promise<CropChoice> {
  if (attached.length >= MAX_BUNDLE_CROPS) {
    return {
      attached,
      leftOut: [...leftOut, `${crop.label} (at most ${MAX_BUNDLE_CROPS} crops are attached)`],
    };
  }
  const data = await readEvidence(crop.ref);
  if (data.length >= MAX_CROP_BYTES) {
    const reason = `${crop.label} (${data.length} bytes; a crop must be under ${MAX_CROP_BYTES})`;
    return { attached, leftOut: [...leftOut, reason] };
  }
  return { attached: [...attached, { item: crop, data }], leftOut };
}

function cropSection({ attached, leftOut }: CropChoice): string {
  const shown =
    attached.length === 0
      ? 'No crop of the element is attached.'
      : `Attached, in this order: ${attached.map(({ item }) => item.label).join(', ')}.`;
  const omitted = leftOut.length === 0 ? [] : [`Left out: ${leftOut.join('; ')}.`];
  return ['## Crops', shown, ...omitted].join('\n');
}

function attemptsSection(attempts: readonly Attempt[]): string {
  const reproduced = attempts.filter((attempt) => attempt.reproduced).length;
  return [
    '## Reproductions, each in a fresh browser context',
    `${reproduced} of ${attempts.length} attempts reproduced it.`,
    ...attempts.map(attemptText),
  ].join('\n');
}

function attemptText({ index, occurrence, reproduced, observed, skipped }: Attempt): string {
  const where =
    occurrence === null
      ? ''
      : ` (screen ${occurrence.screenId}, viewport ${occurrence.viewport}, ${
          occurrence.selector === null ? 'no element' : `element ${untrusted(occurrence.selector)}`
        })`;
  const details = [
    observed === null ? null : `Observed: ${untrusted(observed)}`,
    skipped === null ? null : `Skipped: ${untrusted(skipped)}`,
  ].filter((detail) => detail !== null);
  const outcome = reproduced ? 'reproduced' : 'not reproduced';
  return [`Attempt ${index}${where}: ${outcome}.`, ...details].join(' ');
}

function environmentSection({ browser, os, node, lookover, viewport }: Environment): string {
  return [
    '## Environment',
    `Browser: ${browser}`,
    `OS: ${os}`,
    `Node: ${node}`,
    `Lookover: ${lookover}`,
    `Viewport: ${viewportText(viewport)}`,
  ].join('\n');
}
