// LaTeX correctness checks run on the project as it would be after an edit (spec §12).

import { Refusal, warning, type Warning } from '../errors.js';
import { extractRefs, findMacros, maskForScan, readGroup } from '../model/latex.js';
import type { ProjectOutline } from '../model/outline.js';
import { parseBib } from './bibtex.js';

function counts(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function unitFor(outline: ProjectOutline, file: string, needle: string): string | null {
  const f = outline.files.get(file);
  if (!f) return null;
  const idx = f.text.indexOf(needle);
  if (idx === -1) return file;
  let best = f.root;
  for (const u of f.units) if (u.start <= idx && idx < u.end && (best.kind === 'file' || u.end - u.start <= best.end - best.start)) best = u;
  return best.id;
}

/** ref_unknown_label, label_in_use, label_duplicate. */
export function checkLabels(before: ProjectOutline, after: ProjectOutline, edited: string[]): Refusal | null {
  const allRefsAfter = new Set<string>();
  for (const f of after.files.values()) for (const r of extractRefs(maskForScan(f.text)).refs) allRefsAfter.add(r);

  for (const file of edited) {
    const b = before.files.get(file);
    const a = after.files.get(file);
    if (!a) continue;
    const exB = b ? extractRefs(maskForScan(b.text)) : { labels: [], refs: [], cites: [] };
    const exA = extractRefs(maskForScan(a.text));
    const refsB = counts(exB.refs);
    for (const [key, n] of counts(exA.refs)) {
      if (n > (refsB.get(key) ?? 0) && !after.labelCounts.get(key)) {
        throw new Refusal(
          'ref_unknown_label',
          `The edit adds a reference to label "${key}", which no file defines. Use an existing label (read kind "search" for \\label) or add the \\label first.`,
          { label: key, unit: unitFor(after, file, key), knownLabels: [...after.labelCounts.keys()].sort() },
        );
      }
    }
    const labelsB = counts(exB.labels);
    const labelsA = counts(exA.labels);
    for (const [key, n] of labelsB) {
      if ((labelsA.get(key) ?? 0) < n && !after.labelCounts.get(key) && allRefsAfter.has(key)) {
        const users: string[] = [];
        for (const f of after.files.values()) if (extractRefs(maskForScan(f.text)).refs.includes(key)) users.push(f.path);
        throw new Refusal(
          'label_in_use',
          `The edit removes \\label{${key}}, which is still referenced in ${users.join(', ')}. Update those references in the same batch, or keep the label.`,
          { label: key, referencedIn: users },
        );
      }
    }
    for (const [key, n] of labelsA) {
      if (n > (labelsB.get(key) ?? 0) && (after.labelCounts.get(key) ?? 0) > 1) {
        throw new Refusal('label_duplicate', `Label "${key}" is already defined elsewhere in the project. Pick a unique label.`, { label: key });
      }
    }
  }
  return null;
}

/** Keys from every .bib file the project names (or every .bib file if none are named). */
export function knownCiteKeys(outline: ProjectOutline, bibs: Map<string, string>): Set<string> {
  const named = new Set<string>();
  for (const f of outline.files.values()) for (const b of f.bibResources) named.add(b.replace(/^\.\//, ''));
  const files = [...bibs.keys()].filter((p) => named.size === 0 || named.has(p) || [...named].some((n) => p.endsWith(`/${n}`) || n.endsWith(`/${p}`)));
  const keys = new Set<string>();
  for (const p of files.length ? files : [...bibs.keys()]) for (const e of parseBib(bibs.get(p) ?? '').entries) keys.add(e.key);
  return keys;
}

export function checkCites(before: ProjectOutline, after: ProjectOutline, edited: string[], bibs: Map<string, string>): Warning[] {
  const known = knownCiteKeys(after, bibs);
  const out: Warning[] = [];
  for (const file of edited) {
    const a = after.files.get(file);
    if (!a) continue;
    const b = before.files.get(file);
    const citesB = counts(b ? extractRefs(maskForScan(b.text)).cites : []);
    for (const [key, n] of counts(extractRefs(maskForScan(a.text)).cites)) {
      if (n > (citesB.get(key) ?? 0) && !known.has(key)) {
        out.push(warning('cite_unknown', unitFor(after, file, key), `Citation key "${key}" is not in any .bib file the project uses. The edit landed; the key needs a bib entry.`));
      }
    }
  }
  return out;
}

/** Package and macro declarations, normalized, in a file's text. */
export function declarations(text: string): string[] {
  const m = maskForScan(text);
  const out: string[] = [];
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const h of findMacros(m, ['usepackage', 'RequirePackage'])) out.push(norm(m.slice(h.index, h.end)));
  for (const h of findMacros(m, ['documentclass'])) out.push(norm(m.slice(h.index, h.end)));
  // \newcommand{\x}[n]{body}, \newcommand\x{body}, \DeclareMathOperator{\x}{body}
  const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|DeclareRobustCommand)\*?\s*(\{\\[A-Za-z@]+\}|\\[A-Za-z@]+)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m))) {
    let i = x.index + x[0].length;
    while (i < m.length && /[\s[]/.test(m[i])) {
      if (m[i] === '[') i = m.indexOf(']', i) + 1 || m.length;
      else i++;
    }
    const g = readGroup(m, i);
    out.push(norm(`${x[1]} ${x[2].replace(/[{}]/g, '')} ${g ? g.content : ''}`));
  }
  const def = /\\(?:g|e|x)?def\s*(\\[A-Za-z@]+)([^{]*)/g;
  while ((x = def.exec(m))) {
    const g = readGroup(m, x.index + x[0].length);
    out.push(norm(`def ${x[1]}${x[2]} ${g ? g.content : ''}`));
  }
  return out.sort();
}

export function checkPreamble(beforeText: string, afterText: string, file: string): Refusal | null {
  const b = counts(declarations(beforeText));
  const a = counts(declarations(afterText));
  const added = [...a].filter(([k, n]) => n > (b.get(k) ?? 0)).map(([k]) => k);
  const removed = [...b].filter(([k, n]) => n > (a.get(k) ?? 0)).map(([k]) => k);
  if (!added.length && !removed.length) return null;
  return new Refusal(
    'preamble_change',
    `The edit changes package or macro declarations in ${file}. Ask the user first; pass "allowPreamble": true only if they agreed.`,
    { added, removed },
  );
}
