// LaTeX → addressable units (spec §7). A tolerant, line-oriented parser: it recognises
// headings, block-level environments and blank-line paragraphs, and falls back to plain
// line blocks when the structure doesn't add up. It never guesses.

import { containerHash, textHash } from './hash.js';
import {
  SECTION_LEVELS,
  VERBATIM_ENVS,
  braceDelta,
  extractRefs,
  findBibResources,
  findIncludes,
  maskForScan,
  readGroup,
  splitLines,
  type LineInfo,
} from './latex.js';

export type UnitKind = 'file' | 'preamble' | 'section' | 'env' | 'paragraph' | 'opaque';

export interface Unit {
  id: string;
  pathId: string;
  aliases: string[];
  kind: UnitKind;
  file: string;
  /** [start, end) offsets in the file text. `end` excludes the last line's newline. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  hash: string;
  title?: string;
  envName?: string;
  level?: number;
  /** Sections: offset where the heading lines end. */
  headingEnd?: number;
  verbatim?: boolean;
  labels: string[];
  directLabels: string[];
  refs: string[];
  cites: string[];
  children: Unit[];
  parent: Unit | null;
}

export interface FileOutline {
  path: string;
  text: string;
  parse: 'ok' | 'fallback';
  parseError?: string;
  root: Unit;
  /** All units except the file unit, in document order (sections before their children). */
  units: Unit[];
  includes: string[];
  bibResources: string[];
  isRoot: boolean;
}

export class ParseError extends Error {}

const HEADING_RE = new RegExp(`^\\s*\\\\(${Object.keys(SECTION_LEVELS).join('|')})\\*?\\s*(?:\\[[^\\]]*\\]\\s*)?\\{`);
const BEGIN_RE = /^\s*\\begin\{([^}]+)\}/;
const LABEL_ONLY_RE = /^\s*\\label\{[^}]*\}\s*$/;

function newUnit(kind: UnitKind, file: string, start: number, end: number, startLine: number, endLine: number): Unit {
  return {
    id: '',
    pathId: '',
    aliases: [],
    kind,
    file,
    start,
    end,
    startLine,
    endLine,
    hash: '',
    labels: [],
    directLabels: [],
    refs: [],
    cites: [],
    children: [],
    parent: null,
  };
}

function findEnvEnd(text: string, masked: string, lines: LineInfo[], fromLine: number, name: string, beginOffset: number): number {
  const endTag = `\\end{${name}}`;
  if (VERBATIM_ENVS.has(name)) {
    const idx = text.indexOf(endTag, beginOffset + 1);
    if (idx === -1) return -1;
    return lineIndexAt(lines, idx, fromLine);
  }
  const beginTag = `\\begin{${name}}`;
  let depth = 0;
  let pos = beginOffset;
  for (;;) {
    const b = masked.indexOf(beginTag, pos);
    const e = masked.indexOf(endTag, pos);
    if (e === -1) return -1;
    if (b !== -1 && b < e) {
      depth++;
      pos = b + beginTag.length;
    } else {
      depth--;
      pos = e + endTag.length;
      if (depth === 0) return lineIndexAt(lines, e, fromLine);
    }
  }
}

function lineIndexAt(lines: LineInfo[], offset: number, from = 0): number {
  for (let i = from; i < lines.length; i++) if (offset <= lines[i].end) return i;
  return lines.length - 1;
}

/** Labels not inside a nested environment of the unit's own text. */
function directLabelsOfEnv(maskedSlice: string): string[] {
  // Drop the outer \begin{…} … \end{…} and blank out nested environments.
  const inner = maskedSlice.replace(/^\s*\\begin\{[^}]+\}/, '').replace(/\\end\{[^}]+\}\s*$/, '');
  let out = '';
  let depth = 0;
  const re = /\\(begin|end)\{[^}]+\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    if (depth === 0) out += inner.slice(last, m.index);
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth < 0) depth = 0;
    last = m.index + m[0].length;
  }
  if (depth === 0) out += inner.slice(last);
  return extractRefs(out).labels;
}

function fill(unit: Unit, text: string, masked: string) {
  const ex = extractRefs(masked.slice(unit.start, unit.end));
  unit.labels = ex.labels;
  unit.refs = ex.refs;
  unit.cites = ex.cites;
}

export interface ParseOptions {
  isRoot?: boolean;
}

export function parseFile(path: string, text: string, opts: ParseOptions = {}): FileOutline {
  const masked = maskForScan(text);
  const lines = splitLines(text);
  const mlines = splitLines(masked);
  const includes = findIncludes(masked).map((i) => i.path);
  const bibResources = findBibResources(masked);
  try {
    const root = parseStructured(path, text, masked, lines, mlines);
    return finish(path, text, root, 'ok', undefined, includes, bibResources, !!opts.isRoot);
  } catch (err) {
    const root = parseFallback(path, text, masked, lines);
    const msg = err instanceof Error ? err.message : String(err);
    return finish(path, text, root, 'fallback', msg, includes, bibResources, !!opts.isRoot);
  }
}

function finish(
  path: string,
  text: string,
  root: Unit,
  parse: 'ok' | 'fallback',
  parseError: string | undefined,
  includes: string[],
  bibResources: string[],
  isRoot: boolean,
): FileOutline {
  const units: Unit[] = [];
  const walk = (u: Unit) => {
    for (const c of u.children) {
      c.parent = u;
      units.push(c);
      walk(c);
    }
  };
  walk(root);
  assignPathIds(root);
  return { path, text, parse, parseError, root, units, includes, bibResources, isRoot };
}

function parseStructured(path: string, text: string, masked: string, lines: LineInfo[], mlines: LineInfo[]): Unit {
  const root = newUnit('file', path, 0, text.length, 1, lines.length);
  let bodyStart = 0;
  let bodyEnd = lines.length;
  const docBegin = mlines.findIndex((l) => /\\begin\{document\}/.test(l.text));
  if (docBegin !== -1) {
    if (mlines.slice(0, docBegin).some((l) => l.text.trim() !== '')) {
      const pre = newUnit('preamble', path, lines[0].start, lines[docBegin - 1].end, 1, docBegin);
      fill(pre, text, masked);
      root.children.push(pre);
    }
    bodyStart = docBegin + 1;
    const docEnd = mlines.findIndex((l, i) => i > docBegin && /\\end\{document\}/.test(l.text));
    bodyEnd = docEnd === -1 ? lines.length : docEnd;
    if (docEnd === -1) throw new ParseError('\\begin{document} without \\end{document}');
  }

  const stack: Unit[] = [];
  const container = () => (stack.length ? stack[stack.length - 1] : root);
  let para: { startLine: number; depth: number; opaque: boolean } | null = null;

  const closePara = (lastLine: number) => {
    if (!para) return;
    let endLine = lastLine;
    while (endLine > para.startLine && mlines[endLine].text.trim() === '' && lines[endLine].text.trim() === '') endLine--;
    const u = newUnit(para.opaque ? 'opaque' : 'paragraph', path, lines[para.startLine].start, lines[endLine].end, para.startLine + 1, endLine + 1);
    fill(u, text, masked);
    container().children.push(u);
    para = null;
  };

  let i = bodyStart;
  while (i < bodyEnd) {
    const ml = mlines[i].text;
    const blank = ml.trim() === '' && lines[i].text.trim() === '';
    if (para && para.depth > 0) {
      // Inside an open brace group: everything belongs to this block, even blank lines and headings.
      para.depth += braceDelta(ml);
      if (ml.trim() === '' && lines[i].text.trim() === '') para.opaque = true;
      i++;
      continue;
    }
    if (blank) {
      closePara(i - 1);
      i++;
      continue;
    }
    const h = HEADING_RE.exec(ml);
    if (h) {
      closePara(i - 1);
      const cmd = h[1];
      const braceAt = mlines[i].start + h[0].length - 1;
      const g = readGroup(masked, braceAt);
      if (!g) throw new ParseError(`unbalanced heading at line ${i + 1}`);
      let hEnd = lineIndexAt(lines, g.end - 1, i);
      if (hEnd - i > 4) throw new ParseError(`heading at line ${i + 1} spans too many lines`);
      while (hEnd + 1 < bodyEnd && LABEL_ONLY_RE.test(mlines[hEnd + 1].text)) hEnd++;
      const level = SECTION_LEVELS[cmd];
      while (stack.length && (stack[stack.length - 1].level ?? 0) >= level) stack.pop();
      const sec = newUnit('section', path, lines[i].start, lines[hEnd].end, i + 1, hEnd + 1);
      sec.level = level;
      sec.title = g.content.replace(/\s+/g, ' ').trim();
      sec.headingEnd = lines[hEnd].end;
      const hm = masked.slice(sec.start, sec.headingEnd);
      const ex = extractRefs(hm);
      sec.labels = ex.labels;
      sec.directLabels = ex.labels;
      sec.refs = ex.refs;
      sec.cites = ex.cites;
      container().children.push(sec);
      stack.push(sec);
      i = hEnd + 1;
      continue;
    }
    const b = BEGIN_RE.exec(ml);
    if (b && b[1] !== 'document') {
      closePara(i - 1);
      const name = b[1];
      const beginOffset = mlines[i].start + ml.indexOf('\\begin{');
      const endLine = findEnvEnd(text, masked, lines, i, name, beginOffset);
      if (endLine === -1 || endLine >= bodyEnd) throw new ParseError(`\\begin{${name}} at line ${i + 1} has no matching \\end`);
      const env = newUnit('env', path, lines[i].start, lines[endLine].end, i + 1, endLine + 1);
      env.envName = name;
      env.verbatim = VERBATIM_ENVS.has(name);
      if (!env.verbatim) {
        fill(env, text, masked);
        env.directLabels = directLabelsOfEnv(masked.slice(env.start, env.end));
      }
      container().children.push(env);
      i = endLine + 1;
      continue;
    }
    if (!para) para = { startLine: i, depth: 0, opaque: false };
    para.depth += braceDelta(ml);
    if (para.depth < 0) para.opaque = true;
    i++;
  }
  if (para) {
    if ((para as { depth: number }).depth > 0) (para as { opaque: boolean }).opaque = true;
    closePara(bodyEnd - 1);
  }
  extendSections(root);
  return root;
}

/** A section spans from its heading to the end of its last descendant. */
function extendSections(u: Unit) {
  for (const c of u.children) {
    if (c.kind === 'section') {
      extendSections(c);
      const last = c.children[c.children.length - 1];
      if (last) {
        c.end = Math.max(c.end, last.end);
        c.endLine = Math.max(c.endLine, last.endLine);
      }
    }
  }
}

function parseFallback(path: string, text: string, masked: string, lines: LineInfo[]): Unit {
  const root = newUnit('file', path, 0, text.length, 1, lines.length);
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || lines[i].text.trim() === '';
    if (!blank && start === -1) start = i;
    if (blank && start !== -1) {
      const u = newUnit('paragraph', path, lines[start].start, lines[i - 1].end, start + 1, i);
      fill(u, text, masked);
      root.children.push(u);
      start = -1;
    }
  }
  return root;
}

function assignPathIds(root: Unit) {
  root.pathId = root.file;
  const visit = (c: Unit, prefix: string, secIdx: string) => {
    let s = 0;
    let p = 0;
    let e = 0;
    for (const u of c.children) {
      if (u.kind === 'preamble') u.pathId = `${root.file}/preamble`;
      else if (u.kind === 'section') {
        s++;
        const idx = secIdx ? `${secIdx}.${s}` : `${s}`;
        u.pathId = `${root.file}/§${idx}`;
        visit(u, u.pathId, idx);
      } else if (u.kind === 'env') u.pathId = `${prefix}/env${++e}`;
      else u.pathId = `${prefix}/¶${++p}`;
    }
  };
  visit(root, root.file, '');
}

// ---------------------------------------------------------------------------
// Project level: IDs (label IDs need project-wide uniqueness) and hashes.

export interface ProjectOutline {
  files: Map<string, FileOutline>;
  order: string[];
  rootDoc: string | null;
  includedBy: Map<string, string>;
  byId: Map<string, Unit>;
  labelCounts: Map<string, number>;
  duplicateLabels: string[];
}

function resolveIncludePath(p: string, existing: Set<string>): string | null {
  const clean = p.replace(/^\.\//, '').replace(/^\//, '');
  for (const cand of [clean, `${clean}.tex`]) if (existing.has(cand)) return cand;
  return null;
}

export function buildProjectOutline(docs: { path: string; text: string }[], rootDoc: string | null): ProjectOutline {
  const tex = docs.filter((d) => /\.(tex|ltx|sty|cls)$/i.test(d.path));
  const paths = new Set(tex.map((d) => d.path));
  const files = new Map<string, FileOutline>();
  for (const d of tex) files.set(d.path, parseFile(d.path, d.text, { isRoot: d.path === rootDoc }));

  // Include graph from the root doc.
  const order: string[] = [];
  const includedBy = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    order.push(p);
    for (const inc of files.get(p)?.includes ?? []) {
      const target = resolveIncludePath(inc, paths);
      if (target && !seen.has(target)) {
        includedBy.set(target, p);
        visit(target);
      }
    }
  };
  if (rootDoc && files.has(rootDoc)) visit(rootDoc);
  for (const p of [...files.keys()].sort()) visit(p);

  // Label counts across the whole project.
  const labelCounts = new Map<string, number>();
  for (const f of files.values()) {
    for (const u of f.units) {
      if (u.kind === 'section') {
        for (const l of u.labels) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
      } else if (u.kind !== 'preamble') {
        for (const l of u.labels) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
      }
    }
  }
  const duplicateLabels = [...labelCounts].filter(([, n]) => n > 1).map(([l]) => l);

  const byId = new Map<string, Unit>();
  for (const f of files.values()) {
    f.root.id = f.path;
    for (const u of f.units) {
      const usable = u.kind === 'section' || u.kind === 'env' ? u.directLabels.filter((l) => labelCounts.get(l) === 1) : [];
      u.id = usable[0] ?? u.pathId;
      u.aliases = [...usable.slice(1), ...(u.id !== u.pathId ? [u.pathId] : [])];
    }
    byId.set(f.path, f.root);
    for (const u of f.units) {
      byId.set(u.id, u);
      for (const a of u.aliases) if (!byId.has(a)) byId.set(a, u);
    }
    computeHashes(f.root, f.text);
  }
  return { files, order, rootDoc, includedBy, byId, labelCounts, duplicateLabels };
}

function computeHashes(u: Unit, text: string) {
  for (const c of u.children) computeHashes(c, text);
  if (u.kind === 'file') u.hash = containerHash(u.file, u.children.map((c) => c.id));
  else if (u.kind === 'section') u.hash = containerHash(text.slice(u.start, u.headingEnd), u.children.map((c) => c.id));
  else u.hash = textHash(text.slice(u.start, u.end));
}

/** Leaf (text-bearing) units of a file: everything except sections and the file itself. */
export function leafUnits(f: FileOutline): Unit[] {
  return f.units.filter((u) => u.kind !== 'section');
}

/** Innermost unit containing [start, end) in a file, or the file unit. */
export function unitAt(f: FileOutline, start: number, end = start): Unit {
  let best: Unit = f.root;
  for (const u of f.units) {
    if (u.start <= start && end <= u.end) {
      if (best.kind === 'file' || u.end - u.start <= best.end - best.start) best = u;
    }
  }
  return best;
}

/** Text of a unit. For sections only the heading is "own" text; use `fullText` for the span. */
export function unitText(f: FileOutline, u: Unit): string {
  return f.text.slice(u.start, u.end);
}
