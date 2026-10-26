// Op and target types (spec §8.4) and their resolution to splices on the file text.
// All targets in one call resolve against the text as the agent read it; the resulting
// splices are applied together, so earlier ops don't shift later targets.

import type { Splice } from '../adapters/adapter.js';
import { Refusal } from '../errors.js';
import { describeUnit, fileSummary, resolveUnit } from '../model/ids.js';
import { splitLines } from '../model/latex.js';
import { unitAt, type FileOutline, type ProjectOutline, type Unit } from '../model/outline.js';

export type Target =
  | { kind: 'find'; text: string; within?: string; nth?: number }
  | { kind: 'unit'; id: string }
  | { kind: 'lines'; start: number; end: number; ifHash: string };

export type Side = 'before' | 'after';

export type Op =
  | { op: 'insert'; target: Target; side: Side; content: string; ifHash?: string }
  | { op: 'replace'; target: Target; with: string; ifHash?: string }
  | { op: 'delete'; target: Target; ifHash?: string }
  | { op: 'move'; target: Target; ifHash?: string; to: { kind: 'unit'; id: string; side: Side; ifHash?: string } };

export interface ResolvedSplice extends Splice {
  opIndex: number;
  /** Whether this splice rewrites existing text (replace/delete) — what the diff budget measures. */
  rewrites: boolean;
  /** Part of a move: text is relocated, not changed. */
  move: boolean;
}

export interface Resolution {
  splices: ResolvedSplice[];
  /** Units named or located by each op's target. */
  targets: Unit[][];
}

function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

function snippet(text: string, at: number, len: number): string {
  const s = Math.max(0, at - 40);
  return text.slice(s, Math.min(text.length, at + len + 40));
}

function resolveFind(outline: ProjectOutline, f: FileOutline, t: Extract<Target, { kind: 'find' }>): { start: number; end: number; unit: Unit } {
  let lo = 0;
  let hi = f.text.length;
  if (t.within) {
    const w = resolveUnit(outline, t.within, { file: f.path });
    lo = w.start;
    hi = w.end;
  }
  const hits = findAll(f.text.slice(lo, hi), t.text).map((h) => h + lo);
  if (hits.length === 0) {
    throw new Refusal(
      'find_none',
      `Text ${JSON.stringify(t.text)} not found${t.within ? ` within ${t.within}` : ` in ${f.path}`}. Quote the current text exactly (re-read the unit).`,
      t.within ? describeUnit(f, resolveUnit(outline, t.within, { file: f.path })) : fileSummary(f),
    );
  }
  let start: number;
  if (t.nth !== undefined) {
    if (t.nth < 1 || t.nth > hits.length) {
      throw new Refusal('find_ambiguous', `nth=${t.nth} but the text occurs ${hits.length} time(s).`, {
        matches: hits.map((h) => ({ unit: unitAt(f, h, h + t.text.length).id, context: snippet(f.text, h, t.text.length) })),
      });
    }
    start = hits[t.nth - 1];
  } else if (hits.length > 1) {
    throw new Refusal('find_ambiguous', `Text ${JSON.stringify(t.text)} occurs ${hits.length} times. Quote more words, add "within", or pass "nth".`, {
      matches: hits.map((h) => ({ unit: unitAt(f, h, h + t.text.length).id, context: snippet(f.text, h, t.text.length) })),
    });
  } else start = hits[0];
  const end = start + t.text.length;
  for (const u of f.units) {
    const cuts = (b: number) => start < b && b < end;
    if (cuts(u.start) || cuts(u.end) || (u.headingEnd !== undefined && cuts(u.headingEnd))) {
      throw new Refusal('invalid_op', `Quoted text spans the boundary of unit ${u.id}. Split the edit into one op per unit.`, describeUnit(f, u));
    }
  }
  return { start, end, unit: unitAt(f, start, end) };
}

function requireGuard(op: Op, u: Unit) {
  if (!op.ifHash) {
    throw new Refusal('missing_guard', `${op.op} of whole unit ${u.id} needs "ifHash" (its current hash is in the outline or unit read).`, {
      id: u.id,
      hash: u.hash,
    });
  }
}

function lineBlankAt(text: string, pos: number): boolean {
  // Is the line starting at `pos` blank (or the end of text)?
  const nl = text.indexOf('\n', pos);
  return text.slice(pos, nl === -1 ? text.length : nl).trim() === '';
}

function trimBlock(s: string): string {
  return s.replace(/^\n+/, '').replace(/\s+$/, '');
}

/** Insert `content` as its own blank-line-separated block before or after a unit. */
function blockInsert(text: string, u: Unit, side: Side, content: string): Splice {
  const c = trimBlock(content);
  if (side === 'after') {
    let ins = `\n\n${c}`;
    const nextLineStart = u.end + 1;
    if (u.end < text.length && nextLineStart < text.length && !lineBlankAt(text, nextLineStart)) ins += '\n';
    return { start: u.end, end: u.end, text: ins };
  }
  let ins = `${c}\n\n`;
  if (u.start > 0) {
    const prevLineStart = text.lastIndexOf('\n', u.start - 2) + 1;
    if (!lineBlankAt(text, prevLineStart)) ins = `\n${ins}`;
  }
  return { start: u.start, end: u.start, text: ins };
}

/** Remove a unit's lines plus the blank lines after it, keeping neighbours separated. */
function blockDelete(text: string, u: Unit): Splice {
  const start = u.start;
  let end = u.end;
  if (end < text.length) end++; // own newline
  let consumedBlank = false;
  while (end < text.length) {
    const nl = text.indexOf('\n', end);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(end, lineEnd).trim() !== '') break;
    end = nl === -1 ? text.length : nl + 1;
    consumedBlank = true;
  }
  const prevNonBlank = start > 0 && !lineBlankAt(text, text.lastIndexOf('\n', start - 2) + 1);
  const nextNonBlank = end < text.length;
  return { start, end, text: consumedBlank && prevNonBlank && nextNonBlank ? '\n' : '' };
}

function resolveLines(f: FileOutline, t: Extract<Target, { kind: 'lines' }>): { start: number; end: number; unit: Unit } {
  if (f.parse !== 'fallback') {
    throw new Refusal('invalid_op', `"lines" targets are only for fallback-parsed files; ${f.path} parsed normally. Use a unit or find target.`);
  }
  const lines = splitLines(f.text);
  if (t.start < 1 || t.end < t.start || t.end > lines.length) throw new Refusal('invalid_op', `Lines ${t.start}-${t.end} are out of range (1-${lines.length}).`);
  const u = f.units.find((x) => x.startLine <= t.start && t.end <= x.endLine);
  if (!u) throw new Refusal('invalid_op', `Lines ${t.start}-${t.end} are not inside a single unit.`, fileSummary(f));
  if (u.hash !== t.ifHash) {
    throw new Refusal('guard_mismatch', `Unit ${u.id} containing lines ${t.start}-${t.end} has hash ${u.hash}, not ${t.ifHash}. Re-read it.`, describeUnit(f, u));
  }
  return { start: lines[t.start - 1].start, end: lines[t.end - 1].end, unit: u };
}

export function resolveOps(outline: ProjectOutline, file: string, ops: Op[]): Resolution {
  const f = outline.files.get(file);
  if (!f) throw new Refusal('not_a_doc', `${file} is not a parsed text doc.`);
  const text = f.text;
  const splices: ResolvedSplice[] = [];
  const targets: Unit[][] = [];
  ops.forEach((op, opIndex) => {
    const add = (sp: Splice, rewrites: boolean, move = false) => splices.push({ ...sp, opIndex, rewrites, move });
    const t = op.target;
    if (t.kind === 'find') {
      if (op.op === 'move') throw new Refusal('invalid_op', 'move needs a unit target, not find.');
      const r = resolveFind(outline, f, t);
      targets.push([r.unit]);
      if (op.ifHash && r.unit.hash !== op.ifHash) {
        throw new Refusal('guard_mismatch', `Unit ${r.unit.id} has hash ${r.unit.hash}, not ${op.ifHash}.`, describeUnit(f, r.unit));
      }
      if (op.op === 'insert') add({ start: op.side === 'before' ? r.start : r.end, end: op.side === 'before' ? r.start : r.end, text: op.content }, false);
      else if (op.op === 'replace') add({ start: r.start, end: r.end, text: op.with }, true);
      else add({ start: r.start, end: r.end, text: '' }, true);
      return;
    }
    if (t.kind === 'lines') {
      const r = resolveLines(f, t);
      targets.push([r.unit]);
      if (op.op === 'insert') {
        const c = trimBlock(op.content);
        add(op.side === 'before' ? { start: r.start, end: r.start, text: `${c}\n` } : { start: r.end, end: r.end, text: `\n${c}` }, false);
      } else if (op.op === 'replace') add({ start: r.start, end: r.end, text: op.with.replace(/\n$/, '') }, true);
      else if (op.op === 'delete') add({ start: r.start, end: Math.min(text.length, r.end + 1), text: '' }, true);
      else throw new Refusal('invalid_op', 'move needs a unit target.');
      return;
    }
    const u = resolveUnit(outline, t.id, { ifHash: op.ifHash, file });
    if (u.kind === 'file') throw new Refusal('invalid_op', 'Target a unit inside the file, not the file itself.');
    targets.push([u]);
    if (op.op === 'insert') {
      add(blockInsert(text, u, op.side, op.content), false);
    } else if (op.op === 'replace') {
      requireGuard(op, u);
      add({ start: u.start, end: u.end, text: trimBlock(op.with) }, true);
    } else if (op.op === 'delete') {
      requireGuard(op, u);
      add(blockDelete(text, u), true);
    } else {
      requireGuard(op, u);
      const dest = resolveUnit(outline, op.to.id, { ifHash: op.to.ifHash, file });
      if (dest.start >= u.start && dest.end <= u.end) throw new Refusal('invalid_op', `Cannot move ${u.id} relative to itself or its own child.`);
      targets[targets.length - 1].push(dest);
      add(blockDelete(text, u), false, true);
      add(blockInsert(text, dest, op.to.side, text.slice(u.start, u.end)), false, true);
    }
  });
  checkOverlap(splices, f);
  return { splices, targets };
}

function checkOverlap(splices: ResolvedSplice[], f: FileOutline) {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const overlap = b.start < a.end || (b.start === a.start && a.end > a.start && b.end > b.start);
    if (overlap) {
      throw new Refusal('ops_overlap', `Ops ${a.opIndex} and ${b.opIndex} touch overlapping text in ${f.path}. Combine them into one op.`, {
        a: { op: a.opIndex, text: f.text.slice(a.start, a.end) },
        b: { op: b.opIndex, text: f.text.slice(b.start, b.end) },
      });
    }
  }
}

/** Applies non-overlapping splices (base coordinates). Equal-position inserts keep op order. */
export function applySplices(base: string, splices: Splice[]): string {
  const sorted = splices.map((s, i) => ({ s, i })).sort((x, y) => x.s.start - y.s.start || x.s.end - x.s.start - (y.s.end - y.s.start) || x.i - y.i);
  let out = '';
  let pos = 0;
  for (const { s } of sorted) {
    out += base.slice(pos, s.start) + s.text;
    pos = Math.max(pos, s.end);
  }
  return out + base.slice(pos);
}

/** Maps a base offset into the edited text. Offsets inside a replaced region map to its edge. */
export function mapOffset(splices: Splice[], pos: number, assoc: 'left' | 'right' = 'right'): number {
  let delta = 0;
  for (const s of [...splices].sort((a, b) => a.start - b.start)) {
    const growth = s.text.length - (s.end - s.start);
    if (s.start === s.end && s.start === pos) {
      if (assoc === 'right') delta += growth;
    } else if (s.end <= pos) {
      delta += growth;
    } else if (s.start < pos) {
      return s.start + delta + (assoc === 'right' ? s.text.length : 0);
    } else break;
  }
  return pos + delta;
}
