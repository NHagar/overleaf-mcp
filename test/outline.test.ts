import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveUnit } from '../src/model/ids.js';
import { buildProjectOutline, parseFile } from '../src/model/outline.js';
import { goldenFor } from '../scripts/golden.js';
import { FIXTURES, loadFixture } from './helpers.js';

const outlineOf = (files: Record<string, string>, root = 'main.tex') =>
  buildProjectOutline(Object.entries(files).map(([path, text]) => ({ path, text })), root);

describe('golden outlines', () => {
  for (const name of ['article', 'thesis', 'journal', 'generated', 'review']) {
    it(`${name} matches expected-outline.xml`, () => {
      expect(goldenFor(name)).toBe(readFileSync(join(FIXTURES, name, 'expected-outline.xml'), 'utf8'));
    });
  }
});

describe('hashes', () => {
  it('are stable across runs and ignore CRLF and trailing whitespace', () => {
    const files = loadFixture('article');
    const a = outlineOf(files);
    const b = outlineOf(files);
    const crlf = outlineOf({ ...files, 'main.tex': files['main.tex'].replace(/\n/g, '  \r\n') });
    const ids = (o: ReturnType<typeof outlineOf>) => o.files.get('main.tex')!.units.map((u) => `${u.id}:${u.hash}`);
    expect(ids(b)).toEqual(ids(a));
    expect(ids(crlf)).toEqual(ids(a));
  });

  it('pins known hashes so a second machine must agree', () => {
    const o = outlineOf(loadFixture('article'));
    expect(o.byId.get('fig:pipeline')!.hash).toBe('2f81d801');
    expect(o.byId.get('sec:methods')!.hash).toBe('b8a34666');
  });

  it('section hash ignores child text but tracks child list', () => {
    const files = loadFixture('article');
    const base = outlineOf(files).byId.get('sec:intro')!.hash;
    const edited = outlineOf({ ...files, 'main.tex': files['main.tex'].replace('Coverage has declined', 'Coverage has fallen') });
    expect(edited.byId.get('sec:intro')!.hash).toBe(base);
    const added = outlineOf({ ...files, 'main.tex': files['main.tex'].replace('This paper asks what remains.', 'This paper asks what remains.\n\nA new paragraph.') });
    expect(added.byId.get('sec:intro')!.hash).not.toBe(base);
  });
});

describe('ids', () => {
  it('uses labels, path IDs, and nested section paths', () => {
    const o = outlineOf(loadFixture('article'));
    expect(o.byId.get('sec:methods')!.kind).toBe('section');
    expect(o.byId.get('main.tex/§2/¶1')!.kind).toBe('paragraph');
    expect(o.byId.get('main.tex/§2.1')!.title).toBe('Coding scheme');
    // label IDs also resolve by path
    expect(o.byId.get('main.tex/§2/env1')!.id).toBe('fig:pipeline');
  });

  it('drops label IDs on duplicates and reports them', () => {
    const o = outlineOf({ 'main.tex': '\\begin{document}\n\\section{A}\\label{x}\n\nText.\n\n\\section{B}\n\\label{x}\n\n\\end{document}\n' });
    expect(o.duplicateLabels).toEqual(['x']);
    expect(o.byId.get('main.tex/§1')!.id).toBe('main.tex/§1');
  });

  it('resolves a moved path ID by hash and refuses a stale label hash', () => {
    const files = loadFixture('article');
    const before = outlineOf(files);
    const para = before.byId.get('main.tex/§1/¶2')!;
    const moved = outlineOf({ ...files, 'main.tex': files['main.tex'].replace('Local news matters', 'New first paragraph.\n\nLocal news matters') });
    expect(resolveUnit(moved, 'main.tex/§1/¶2', { ifHash: para.hash }).pathId).toBe('main.tex/§1/¶3');
    expect(() => resolveUnit(moved, 'fig:pipeline', { ifHash: 'deadbeef' })).toThrow(/guard_mismatch/);
  });
});

describe('parser tolerance', () => {
  it('keeps verbatim opaque and does not extract from comments', () => {
    const f = parseFile('a.tex', '\\begin{document}\n% \\label{commented}\nText \\ref{real}.\n\n\\begin{verbatim}\n\\label{inverb}\n\\end{verbatim}\n\\end{document}\n');
    expect(f.parse).toBe('ok');
    expect(f.units[0].refs).toEqual(['real']);
    expect(f.units[0].labels).toEqual([]);
    expect(f.units[1].verbatim).toBe(true);
    expect(f.units[1].labels).toEqual([]);
  });

  it('falls back to line blocks on an unclosed environment', () => {
    const f = parseFile('a.tex', '\\section{A}\n\n\\begin{figure}\nnever closed\n\nMore.\n');
    expect(f.parse).toBe('fallback');
    expect(f.units.every((u) => u.kind === 'paragraph')).toBe(true);
  });

  it('marks multi-paragraph brace groups opaque instead of guessing', () => {
    const f = parseFile('a.tex', '\\begin{document}\n\\textbf{one\n\ntwo}\n\nAfter.\n\\end{document}\n');
    expect(f.units.map((u) => u.kind)).toEqual(['opaque', 'paragraph']);
  });

  it('follows \\include, \\input and \\import', () => {
    const o = outlineOf({
      'main.tex': '\\begin{document}\n\\include{ch/a}\n\\import{ch/}{b}\n\\end{document}\n',
      'ch/a.tex': 'A.\n',
      'ch/b.tex': 'B.\n',
    });
    expect(o.order).toEqual(['main.tex', 'ch/a.tex', 'ch/b.tex']);
    expect(o.includedBy.get('ch/b.tex')).toBe('main.tex');
  });

  it('extracts multi-key cites and cref lists', () => {
    const f = parseFile('a.tex', 'See \\citep[p.~3]{a, b} and \\cref{x,y} and \\parencite*{c}.\n');
    expect(f.units[0].cites).toEqual(['a', 'b', 'c']);
    expect(f.units[0].refs).toEqual(['x', 'y']);
  });
});
