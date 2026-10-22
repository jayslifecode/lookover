import { type Finding, type FindingsFile, LookoverError } from '@jayslifecode/lookover-core';

/** An ambiguous prefix lists at most this many of the ids it matches. */
const LISTED_MATCHES = 5;

/** What to do about an id that names no finding of the file at `where` (as the user would write it). */
export function findingIdHint(where: string): string {
  return `Copy the id of a finding from ${where}; the start of it is enough when only one id starts so`;
}

/** The finding id the user typed, without the spaces around it; `E_USAGE` when that leaves nothing. */
export function parseFindingId(value: string, where: string): string {
  const id = value.trim();
  if (id === '') {
    throw new LookoverError('E_USAGE', 'The finding id is empty', findingIdHint(where));
  }
  return id;
}

/**
 * The one finding of `file` (confirmed, rejected, intended or worth a look) whose id is `query` or starts
 * with it. Fails with `E_USAGE` for an id no finding has, or a prefix several ids start with (listing
 * them); `where` names the file in the message.
 */
export function findFinding(file: FindingsFile, query: string, where: string): Finding {
  const findings = firstOfEachId([...file.findings, ...file.rejected, ...file.intended, ...file.worthALook]);
  const exact = findings.find(({ id }) => id === query);
  if (exact !== undefined) {
    return exact;
  }
  const matches = findings.filter(({ id }) => id.startsWith(query));
  const [only] = matches;
  if (only === undefined) {
    throw new LookoverError('E_USAGE', `No finding in ${where} has the id "${query}"`, findingIdHint(where));
  }
  if (matches.length > 1) {
    const listed = matches
      .slice(0, LISTED_MATCHES)
      .map(({ id }) => id)
      .join(', ');
    const more = matches.length > LISTED_MATCHES ? ', …' : '';
    throw new LookoverError(
      'E_USAGE',
      `"${query}" is the start of ${matches.length} finding ids: ${listed}${more}`,
      'Give more of the id, so that only one finding id starts with it',
    );
  }
  return only;
}

/** Each id once: the first finding that has it, in the order of the lists. */
function firstOfEachId(findings: readonly Finding[]): Finding[] {
  const ids = findings.map(({ id }) => id);
  return findings.filter(({ id }, index) => ids.indexOf(id) === index);
}
