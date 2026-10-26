// Token-level diff used to turn coarse replacements into small tracked changes, and by
// the reflow check. Tokens are words, single punctuation marks and whitespace runs.

import type { Splice } from '../adapters/adapter.js';

export function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}_]+|./gsu) ?? [];
}

export type DiffPart = { kind: 'equal' | 'delete' | 'insert'; tokens: string[] };

const MAX_CELLS = 4_000_000;

/** LCS diff on tokens. Returns null if the inputs are too large for the DP table. */
export function diffTokens(a: string[], b: string[]): DiffPart[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], t: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.tokens.push(t);
    else parts.push({ kind, tokens: [t] });
  };
  for (const t of a.slice(0, pre)) push('equal', t);
  if (A.length && B.length) {
    if ((A.length + 1) * (B.length + 1) > MAX_CELLS) return null;
    const n = A.length;
    const m = B.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        push('equal', A[i]);
        i++;
        j++;
      } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) push('delete', A[i++]);
      else push('insert', B[j++]);
    }
    while (i < n) push('delete', A[i++]);
    while (j < m) push('insert', B[j++]);
  } else {
    for (const t of A) push('delete', t);
    for (const t of B) push('insert', t);
  }
  for (const t of a.slice(a.length - suf)) push('equal', t);
  return parts;
}

/**
 * Splits one replacement into word-level splices (base coordinates), so a coauthor reviewing
 * the tracked change sees only what changed. Equal runs of a single whitespace token between
 * changes are folded in, to avoid a confetti of tiny changes.
 */
export function refineSplice(base: string, sp: Splice): Splice[] {
  const oldSeg = base.slice(sp.start, sp.end);
  if (!oldSeg || !sp.text) return [sp];
  const parts = diffTokens(tokenize(oldSeg), tokenize(sp.text));
  if (!parts) return [sp];
  const out: Splice[] = [];
  let pos = sp.start;
  let cur: Splice | null = null;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    const s = p.tokens.join('');
    if (p.kind === 'equal') {
      const between = cur && k + 1 < parts.length && p.tokens.length === 1 && /^[ \t]+$/.test(s);
      if (between && cur) {
        cur.end = pos + s.length;
        cur.text += s;
      } else if (cur) {
        out.push(cur);
        cur = null;
      }
      pos += s.length;
    } else if (p.kind === 'delete') {
      cur ??= { start: pos, end: pos, text: '' };
      cur.end = pos + s.length;
      pos += s.length;
    } else {
      cur ??= { start: pos, end: pos, text: '' };
      cur.text += s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Normalized view for the diff budget: whitespace runs collapse to one space. */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
