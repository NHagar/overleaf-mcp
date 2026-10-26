import { describe, expect, it } from 'vitest';
import { checkBudget, checkReflow, rewrittenUnits } from '../src/edit/budget.js';
import { refineSplice } from '../src/edit/diff.js';
import { applySplices, mapOffset, resolveOps, type Op } from '../src/edit/ops.js';
import { Refusal } from '../src/errors.js';
import { buildProjectOutline } from '../src/model/outline.js';
import { checkPreamble, declarations } from '../src/checks/latexchecks.js';
import { parseBib } from '../src/checks/bibtex.js';
import { generatedInfo } from '../src/checks/generated.js';
import { loadFixture } from './helpers.js';

const article = loadFixture('article');
const outline = () => buildProjectOutline([{ path: 'main.tex', text: article['main.tex'] }], 'main.tex');
const refusalCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return e.code;
    throw e;
  }
  return null;
};
const edit = (ops: Op[]) => {
  const o = outline();
  const r = resolveOps(o, 'main.tex', ops);
  return { o, r, text: applySplices(article['main.tex'], r.splices) };
};

describe('targets', () => {
  it('find replaces exact text within a unit', () => {
    const { text } = edit([{ op: 'replace', target: { kind: 'find', text: '12,000 articles', within: 'sec:methods' }, with: '\\nArticles{} articles' }]);
    expect(text).toContain('We collected \\nArticles{} articles from 40 outlets.');
  });

  it('find_none, find_ambiguous, nth', () => {
    expect(refusalCode(() => edit([{ op: 'delete', target: { kind: 'find', text: 'not there' } }]))).toBe('find_none');
    expect(refusalCode(() => edit([{ op: 'delete', target: { kind: 'find', text: 'Coverage' } }]))).toBe('find_ambiguous');
    const { text } = edit([{ op: 'replace', target: { kind: 'find', text: 'Coverage', nth: 3 }, with: 'Reporting' }]);
    expect(text).toContain('\\item Reporting fell.');
  });

  it('refuses find text that crosses a unit boundary', () => {
    expect(refusalCode(() => edit([{ op: 'delete', target: { kind: 'find', text: 'sec:methods}.\n\n\\section{Methods}' } }]))).toBe('invalid_op');
  });

  it('whole-unit replace needs ifHash', () => {
    expect(refusalCode(() => edit([{ op: 'replace', target: { kind: 'unit', id: 'fig:pipeline' }, with: 'x' }]))).toBe('missing_guard');
    expect(refusalCode(() => edit([{ op: 'replace', target: { kind: 'unit', id: 'fig:pipeline' }, ifHash: '00000000', with: 'x' }]))).toBe('guard_mismatch');
  });

  it('insert after a unit makes its own block', () => {
    const { text } = edit([{ op: 'insert', target: { kind: 'unit', id: 'fig:pipeline' }, side: 'after', content: 'As Figure~\\ref{fig:pipeline} shows, it works.' }]);
    expect(text).toContain('\\end{figure}\n\nAs Figure~\\ref{fig:pipeline} shows, it works.\n\nAgreement was high');
  });

  it('delete removes the unit and one separator', () => {
    const o = outline();
    const u = o.byId.get('main.tex/§2.1/¶1')!;
    const { text } = edit([{ op: 'delete', target: { kind: 'unit', id: u.id }, ifHash: u.hash }]);
    expect(text).toContain('\\subsection{Coding scheme}\n\n\\begin{table}');
  });

  it('move relocates a unit', () => {
    const o = outline();
    const fig = o.byId.get('fig:pipeline')!;
    const { text } = edit([{ op: 'move', target: { kind: 'unit', id: 'fig:pipeline' }, ifHash: fig.hash, to: { kind: 'unit', id: 'eq:kappa', side: 'after' } }]);
    expect(text.indexOf('\\label{eq:kappa}')).toBeLessThan(text.indexOf('\\label{fig:pipeline}'));
    expect(text.match(/fig:pipeline\}/g)!.length).toBe(1);
  });

  it('refuses overlapping ops', () => {
    expect(
      refusalCode(() =>
        edit([
          { op: 'replace', target: { kind: 'find', text: '12,000 articles' }, with: 'a' },
          { op: 'replace', target: { kind: 'find', text: 'articles from 40' }, with: 'b' },
        ]),
      ),
    ).toBe('ops_overlap');
  });

  it('applies multiple ops against the original text', () => {
    const { text } = edit([
      { op: 'insert', target: { kind: 'find', text: 'Local news matters' }, side: 'before', content: 'Indeed, ' },
      { op: 'replace', target: { kind: 'find', text: 'two decades' }, with: 'twenty years' },
    ]);
    expect(text).toContain('Indeed, Local news matters');
    expect(text).toContain('twenty years');
  });
});

describe('offsets and refinement', () => {
  it('maps offsets through splices', () => {
    const sp = [{ start: 2, end: 4, text: 'XYZ' }, { start: 6, end: 6, text: '!' }];
    expect(applySplices('abcdefgh', sp)).toBe('abXYZef!gh');
    expect(mapOffset(sp, 1)).toBe(1);
    expect(mapOffset(sp, 5)).toBe(6);
    expect(mapOffset(sp, 6, 'left')).toBe(7);
    expect(mapOffset(sp, 6, 'right')).toBe(8);
  });

  it('refines a coarse replace into word-level splices', () => {
    const base = 'The quick brown fox jumps.';
    const sp = refineSplice(base, { start: 0, end: base.length, text: 'The slow brown fox leaps.' });
    expect(applySplices(base, sp)).toBe('The slow brown fox leaps.');
    expect(sp.map((s) => base.slice(s.start, s.end))).toEqual(['quick', 'jumps']);
  });
});

describe('budget and reflow', () => {
  const para = 'One sentence here.\nAnother sentence follows it.\nA third line ends the paragraph.';
  const doc = `\\begin{document}\n${para}\n\\end{document}\n`;
  const o = buildProjectOutline([{ path: 'a.tex', text: doc }], 'a.tex');
  const run = (ops: Op[], threshold = 0.25) => {
    const r = resolveOps(o, 'a.tex', ops);
    const next = applySplices(doc, r.splices);
    const changes = rewrittenUnits(o.files.get('a.tex')!, next, r.splices);
    checkBudget(changes, threshold);
    checkReflow(changes);
    return next;
  };

  it('allows small replacements and refuses large ones', () => {
    expect(run([{ op: 'replace', target: { kind: 'find', text: 'follows' }, with: 'comes after' }])).toContain('comes after');
    const u = o.files.get('a.tex')!.units[0];
    expect(refusalCode(() => run([{ op: 'replace', target: { kind: 'unit', id: u.id }, ifHash: u.hash, with: 'Totally different words replace everything here now.' }]))).toBe('over_budget');
    expect(refusalCode(() => run([{ op: 'delete', target: { kind: 'unit', id: u.id }, ifHash: u.hash }]))).toBe('over_budget');
  });

  it('a 40% change is over the default budget', () => {
    const u = o.files.get('a.tex')!.units[0];
    // Replace the last ~40% of characters.
    const keep = para.slice(0, Math.floor(para.length * 0.6));
    const repl = keep + 'x'.repeat(para.length - keep.length);
    expect(refusalCode(() => run([{ op: 'replace', target: { kind: 'unit', id: u.id }, ifHash: u.hash, with: repl }]))).toBe('over_budget');
  });

  it('refuses reflow of untouched lines', () => {
    expect(refusalCode(() => run([{ op: 'replace', target: { kind: 'find', text: 'here.\nAnother' }, with: 'here. Another' }]))).toBe('reflow');
  });
});

describe('preamble, bib, generated', () => {
  it('detects package and macro changes', () => {
    expect(declarations('\\usepackage[x]{a}\n\\newcommand{\\foo}[1]{bar #1}\n\\def\\baz{q}\n')).toHaveLength(3);
    expect(checkPreamble('\\usepackage{a}\n', '\\usepackage{a}\n\\usepackage{b}\n', 'm.tex')?.code).toBe('preamble_change');
    expect(checkPreamble('\\usepackage{a}\nText.\n', '\\usepackage{a}\nText changed.\n', 'm.tex')).toBeNull();
  });

  it('parses bib entries, including nested braces and @string', () => {
    const r = parseBib('@string{j = "J"}\n@article{k1, title = {A {B} c}, journal = j # " x", year = 2020}\n@book{k2,\n title="T"}\n');
    expect(r.errors).toEqual([]);
    expect(r.entries.map((e) => e.key)).toEqual(['k1', 'k2']);
    expect(r.entries[0].fields.title).toBe('A {B} c');
  });

  it('reads the generated-by header', () => {
    expect(generatedInfo('% generated-by: s.py from d.csv\n\\newcommand{\\x}{1}')).toEqual({ script: 's.py', data: 'd.csv' });
    expect(generatedInfo('\\newcommand{\\x}{1}')).toBeNull();
  });
});
