// Diff budget (spec §10) and the reflow check (§12), measured per existing unit.

import { distance } from 'fastest-levenshtein';
import { Refusal } from '../errors.js';
import type { FileOutline, Unit } from '../model/outline.js';
import { diffTokens, normalizeWs, tokenize } from './diff.js';
import { mapOffset, type ResolvedSplice } from './ops.js';

export interface UnitChange {
  unit: Unit;
  oldText: string;
  newText: string;
  deleted: boolean;
}

/** The span a unit "owns" for budget purposes: sections only own their heading. */
function ownSpan(u: Unit): [number, number] {
  return u.kind === 'section' ? [u.start, u.headingEnd ?? u.end] : [u.start, u.end];
}

/** Existing units whose text is rewritten (replace/delete) by the splices. */
export function rewrittenUnits(before: FileOutline, newText: string, splices: ResolvedSplice[]): UnitChange[] {
  const out: UnitChange[] = [];
  for (const u of before.units) {
    const [s, e] = ownSpan(u);
    const hits = splices.filter((sp) => sp.rewrites && sp.start < e && sp.end > s);
    if (!hits.length) continue;
    const deleted = hits.some((sp) => sp.start <= s && sp.end >= e && sp.text.trim() === '');
    const ns = mapOffset(splices, s, 'right');
    const ne = mapOffset(splices, e, 'left');
    out.push({ unit: u, oldText: before.text.slice(s, e), newText: deleted ? '' : newText.slice(ns, Math.max(ns, ne)), deleted });
  }
  return out;
}

export function changeRatio(c: UnitChange): number {
  if (c.deleted) return 1;
  const a = normalizeWs(c.oldText);
  const b = normalizeWs(c.newText);
  return distance(a, b) / Math.max(1, a.length);
}

export function checkBudget(changes: UnitChange[], threshold: number): void {
  for (const c of changes) {
    if (c.unit.kind === 'preamble') continue;
    const ratio = changeRatio(c);
    if (ratio > threshold) {
      throw new Refusal(
        'over_budget',
        `The edit changes ${(ratio * 100).toFixed(0)}% of unit ${c.unit.id} (limit ${(threshold * 100).toFixed(0)}%). Make a smaller edit that keeps the author's sentences, or pass "rewrite": true only if the user asked for a rewrite.`,
        { unit: c.unit.id, hash: c.unit.hash, ratio: Number(ratio.toFixed(3)), threshold, text: c.oldText },
      );
    }
  }
}

/** Old line numbers (0-based, within the unit) that hold a changed word. */
function changedLines(oldText: string, parts: NonNullable<ReturnType<typeof diffTokens>>): Set<number> {
  const changed = new Set<number>();
  let pos = 0;
  const lineAt = (p: number) => oldText.slice(0, p).split('\n').length - 1;
  for (const p of parts) {
    const s = p.tokens.join('');
    if (p.kind === 'delete') {
      if (/\S/.test(s)) for (let l = lineAt(pos); l <= lineAt(pos + s.length); l++) changed.add(l);
      pos += s.length;
    } else if (p.kind === 'insert') {
      if (/\S/.test(s)) changed.add(lineAt(pos));
    } else pos += s.length;
  }
  return changed;
}

/** Refuses edits that move line breaks between words that themselves didn't change. */
export function checkReflow(changes: UnitChange[]): void {
  for (const c of changes) {
    if (c.deleted || c.unit.verbatim) continue;
    const parts = diffTokens(tokenize(c.oldText), tokenize(c.newText));
    if (!parts) continue;
    const changed = changedLines(c.oldText, parts);
    let pos = 0;
    for (let k = 0; k < parts.length; k++) {
      if (parts[k].kind === 'equal') {
        pos += parts[k].tokens.join('').length;
        continue;
      }
      // A run of non-equal parts.
      let j = k;
      let del = '';
      let ins = '';
      while (j < parts.length && parts[j].kind !== 'equal') {
        if (parts[j].kind === 'delete') del += parts[j].tokens.join('');
        else ins += parts[j].tokens.join('');
        j++;
      }
      const wsOnly = !/\S/.test(del) && !/\S/.test(ins);
      const nlDiff = (del.match(/\n/g)?.length ?? 0) !== (ins.match(/\n/g)?.length ?? 0);
      if (wsOnly && nlDiff && k > 0 && j < parts.length) {
        const before = c.oldText.slice(0, pos).split('\n').length - 1;
        const after = c.oldText.slice(0, pos + del.length).split('\n').length - 1;
        if (!changed.has(before) && !changed.has(after)) {
          throw new Refusal(
            'reflow',
            `The edit moves line breaks in unit ${c.unit.id} between words that didn't change. Keep untouched lines exactly as they are.`,
            { unit: c.unit.id, hash: c.unit.hash, near: c.oldText.slice(Math.max(0, pos - 30), pos + del.length + 30) },
          );
        }
      }
      pos += del.length;
      k = j - 1;
    }
  }
}
