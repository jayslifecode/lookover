import { access, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isMissingFile, writeFileAtomic } from '../util/fs.js';
import { sha256 } from '../util/hash.js';
import { redactDeep } from '../util/redact.js';

const EVIDENCE_DIR = 'evidence';
const ID_LENGTH = 16;
const FALLBACK_JSON_NAME = 'data';
const PNG_FILE = new RegExp(`^(?<id>[0-9a-f]{${ID_LENGTH}})\\.png$`);
const JSON_FILE = new RegExp(`^[a-z0-9-]+-(?<id>[0-9a-f]{${ID_LENGTH}})\\.json$`);

export interface EvidenceRef {
  /** First 16 hex characters of the sha256 of the bytes that were written. */
  readonly id: string;
  /** Location relative to the run directory, always with forward slashes. */
  readonly path: string;
  readonly bytes: number;
  readonly kind: 'png' | 'json';
}

/**
 * Content-addressed store for everything a run produces. Identical bytes are stored once.
 *
 * JSON values are flattened to plain JSON (so `toJSON`, class instances, `Date`s and `URL`s are
 * already strings) and then run through `redactDeep` before they are hashed or written. String
 * values and values under sensitive keys are therefore redacted; object keys are not, because
 * that is `redactDeep`'s contract. PNGs are stored as given: they are pixels, not text.
 */
export class EvidenceStore {
  private readonly runDir: string;
  private readonly evidenceDir: string;

  constructor(runDir: string) {
    this.runDir = resolve(runDir);
    this.evidenceDir = join(this.runDir, EVIDENCE_DIR);
  }

  async putPng(buffer: Buffer): Promise<EvidenceRef> {
    const id = idOf(buffer);
    return this.put({ id, path: `${EVIDENCE_DIR}/${id}.png`, bytes: buffer.length, kind: 'png' }, buffer);
  }

  async putJson(name: string, value: unknown): Promise<EvidenceRef> {
    const text = `${JSON.stringify(redactDeep(toPlainJson(value)), null, 2)}\n`;
    const data = Buffer.from(text, 'utf8');
    const id = idOf(data);
    const path = `${EVIDENCE_DIR}/${sanitiseName(name)}-${id}.json`;
    return this.put({ id, path, bytes: data.length, kind: 'json' }, data);
  }

  resolve(ref: EvidenceRef): string {
    return join(this.runDir, ref.path);
  }

  async list(): Promise<EvidenceRef[]> {
    const files = await this.readEvidenceDir();
    const refs = await Promise.all(files.map((file) => this.refFromFile(file)));
    return refs.filter((ref) => ref !== undefined).sort((a, b) => compareCodePoints(a.path, b.path));
  }

  private async put(ref: EvidenceRef, data: Buffer): Promise<EvidenceRef> {
    const target = this.resolve(ref);
    if (await fileExists(target)) return ref;
    await mkdir(this.evidenceDir, { recursive: true });
    // A content-addressed name must never hold partial bytes.
    await writeFileAtomic(target, data);
    return ref;
  }

  private async readEvidenceDir(): Promise<string[]> {
    try {
      return await readdir(this.evidenceDir);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async refFromFile(file: string): Promise<EvidenceRef | undefined> {
    const pngId = PNG_FILE.exec(file)?.groups?.id;
    const jsonId = JSON_FILE.exec(file)?.groups?.id;
    const id = pngId ?? jsonId;
    if (id === undefined) return undefined;
    const { size } = await stat(join(this.evidenceDir, file));
    return { id, path: `${EVIDENCE_DIR}/${file}`, bytes: size, kind: pngId === undefined ? 'json' : 'png' };
  }
}

/** Round-trip through JSON so redaction sees the final strings; values with no JSON form become null. */
function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value) ?? 'null');
}

function idOf(data: Buffer): string {
  return sha256(data).slice(0, ID_LENGTH);
}

/** Lowercase, anything outside [a-z0-9] becomes a single dash, edge dashes are trimmed. */
function sanitiseName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? FALLBACK_JSON_NAME : cleaned;
}

function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
