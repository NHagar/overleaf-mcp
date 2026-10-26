// Outline and unit rendering for `read`.

import type { DocState } from '../adapters/adapter.js';
import { splitLines } from '../model/latex.js';
import type { FileOutline, ProjectOutline, Unit } from '../model/outline.js';

export function xmlAttr(v: string | number): string {
  return String(v).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rangeCounts(doc: DocState | undefined, u: Unit) {
  if (!doc) return { comments: 0, tracked: 0 };
  const inside = (pos: number) => pos >= u.start && pos <= u.end;
  return {
    comments: doc.ranges.comments.filter((c) => inside(c.pos)).length,
    tracked: doc.ranges.changes.filter((c) => inside(c.pos)).length,
  };
}

export interface OutlineOptions {
  file?: string;
  full?: boolean;
  /** Units changed in the change log since this project version are never collapsed. */
  recentlyChanged?: Set<string>;
  projectId: string;
  ver: number;
  compiler: string;
  texlive: string | null;
}

const GAP_MIN_RUN = 8;
const GAP_FILE_MIN_UNITS = 60;

export function renderOutline(outline: ProjectOutline, docs: Map<string, DocState>, o: OutlineOptions): string {
  const lines: string[] = [];
  lines.push(
    `<project id='${xmlAttr(o.projectId)}' ver='${o.ver}' root='${xmlAttr(outline.rootDoc ?? '')}' compiler='${xmlAttr(o.compiler)}' texlive='${xmlAttr(o.texlive ?? '')}'>`,
  );
  for (const path of outline.order) {
    if (o.file && path !== o.file) continue;
    const f = outline.files.get(path)!;
    const doc = docs.get(path);
    const attrs = [`path='${xmlAttr(path)}'`];
    const inc = outline.includedBy.get(path);
    if (inc) attrs.push(`included-by='${xmlAttr(inc)}'`);
    attrs.push(`ver='${doc?.version ?? 0}'`, `h='${f.root.hash}'`);
    if (f.parse === 'fallback') attrs.push(`parse='fallback'`);
    if (doc && doc.otType !== 'sharejs-text-ot') attrs.push(`readonly='${xmlAttr(doc.otType)}'`);
    lines.push(`  <file ${attrs.join(' ')}>`);
    const collapse = !o.full && f.units.length >= GAP_FILE_MIN_UNITS;
    renderChildren(f, f.root, doc, 2, lines, collapse, o.recentlyChanged);
    lines.push('  </file>');
  }
  for (const [p, d] of docs) {
    if (outline.files.has(p) || (o.file && o.file !== p)) continue;
    lines.push(`  <doc path='${xmlAttr(p)}' ver='${d.version}'/>`);
  }
  if (outline.duplicateLabels.length) {
    lines.push(`  <duplicate_label labels='${xmlAttr(outline.duplicateLabels.join(','))}'/>`);
  }
  lines.push('</project>');
  return lines.join('\n');
}

function plain(u: Unit, doc: DocState | undefined, recent?: Set<string>): boolean {
  const c = rangeCounts(doc, u);
  return u.kind === 'paragraph' && u.id === u.pathId && !c.comments && !c.tracked && !recent?.has(u.id);
}

function renderChildren(f: FileOutline, parent: Unit, doc: DocState | undefined, depth: number, out: string[], collapse: boolean, recent?: Set<string>) {
  const pad = '  '.repeat(depth);
  const kids = parent.children;
  for (let i = 0; i < kids.length; i++) {
    if (collapse && plain(kids[i], doc, recent)) {
      let j = i;
      while (j < kids.length && plain(kids[j], doc, recent)) j++;
      if (j - i >= GAP_MIN_RUN) {
        renderUnit(f, kids[i], doc, depth, out, collapse, recent);
        out.push(`${pad}<gap units='${j - i - 2}' lines='${kids[i + 1].startLine}-${kids[j - 2].endLine}'/>`);
        renderUnit(f, kids[j - 1], doc, depth, out, collapse, recent);
        i = j - 1;
        continue;
      }
    }
    renderUnit(f, kids[i], doc, depth, out, collapse, recent);
  }
}

function renderUnit(f: FileOutline, u: Unit, doc: DocState | undefined, depth: number, out: string[], collapse: boolean, recent?: Set<string>) {
  const pad = '  '.repeat(depth);
  const attrs = [`id='${xmlAttr(u.id)}'`];
  if (u.kind === 'section') attrs.push(`title='${xmlAttr(u.title ?? '')}'`);
  if (u.kind === 'env') attrs.push(`name='${xmlAttr(u.envName ?? '')}'`);
  attrs.push(`h='${u.hash}'`, `lines='${u.startLine}-${u.endLine}'`);
  if (u.aliases.length && u.id !== u.pathId) attrs.push(`path='${xmlAttr(u.pathId)}'`);
  if (u.kind !== 'section') {
    const c = rangeCounts(doc, u);
    if (c.comments) attrs.push(`comments='${c.comments}'`);
    if (c.tracked) attrs.push(`tracked='${c.tracked}'`);
  }
  if (u.children.length) {
    out.push(`${pad}<${u.kind} ${attrs.join(' ')}>`);
    renderChildren(f, u, doc, depth + 1, out, collapse, recent);
    out.push(`${pad}</${u.kind}>`);
  } else out.push(`${pad}<${u.kind} ${attrs.join(' ')}/>`);
}

/** Unit source with 1-based line numbers. Sections show their heading lines only. */
export function numberedSource(f: FileOutline, u: Unit): string {
  const end = u.kind === 'section' ? (u.headingEnd ?? u.end) : u.end;
  const lines = splitLines(f.text);
  const out: string[] = [];
  for (let i = u.startLine - 1; i < lines.length && lines[i].start <= end; i++) {
    if (lines[i].start > end) break;
    out.push(`${String(i + 1).padStart(5)}| ${lines[i].text}`);
    if (lines[i].end >= end) break;
  }
  return out.join('\n');
}
