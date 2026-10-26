import { createHash } from 'node:crypto';

/** Line endings to \n, trailing whitespace removed from each line (spec §7.4). */
export function normalizeForHash(src: string): string {
  return src
    .split('\n')
    .map((l) => l.replace(/[ \t\r]+$/, ''))
    .join('\n');
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function textHash(src: string): string {
  return sha256hex(normalizeForHash(src)).slice(0, 8);
}

/** Containers hash their heading line plus the ordered child IDs, not the children's text. */
export function containerHash(heading: string, childIds: string[]): string {
  return sha256hex(normalizeForHash(heading) + '\n' + childIds.join('\n')).slice(0, 8);
}
