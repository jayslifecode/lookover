import { createHash } from 'node:crypto';

const DEFAULT_SHORT_ID_LENGTH = 12;

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function shortId(data: Buffer | string, length = DEFAULT_SHORT_ID_LENGTH): string {
  return sha256(data).slice(0, length);
}
