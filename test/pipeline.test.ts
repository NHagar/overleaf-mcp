import { describe, expect, it } from 'vitest';
import type { MemoryProject } from '../src/adapters/memory/index.js';
import * as h from '../src/tools/handlers.js';
import { call, loadFixture, loadRanges, makeEnv, project } from './helpers.js';

const P = 'p1';

async function setup(fixture = 'article', extra = {}) {
  const env = makeEnv([project(P, fixture, extra)]);
  const mem = env.backend.projects.get(P) as MemoryProject;
  const outline = await call(h.read(env.ctx, { kind: 'outline', projectId: P }));
  const ver = (file = 'main.tex') => mem.docs.get(file)!.version;
  const unit = async (id: string) => (await call(h.read(env.ctx, { kind: 'unit', projectId: P, id }))).unit;
  return { env, mem, outline, ver, unit };
}

describe('update (Phase 2 acceptance on the memory backend)', () => {
  it('an insert lands as a tracked change with receipts', async () => {
    const { env, mem, ver } = await setup();
    const r = await call(
      h.update(env.ctx, {
        projectId: P,
        file: 'main.tex',
        ifVersion: ver(),
        ops: [{ op: 'insert', target: { kind: 'unit', id: 'fig:pipeline' }, side: 'after', content: 'As Figure~\\ref{fig:pipeline} shows, it works.' }],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    const changes = mem.docs.get('main.tex')!.ranges.changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'insert', text: expect.stringContaining('As Figure') });
    expect(r.receipts[0].trackedChanges).toEqual([changes[0].id]);
    expect(r.receipts[0].units.map((u: { id: string }) => u.id)).toContain('main.tex/§2/¶2');
  });

  it('a stale ifHash is refused with the current unit', async () => {
    const { env, ver } = await setup();
    const r = await call(
      h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'replace', target: { kind: 'unit', id: 'fig:pipeline' }, ifHash: 'aaaaaaaa', with: 'x' }] }),
    );
    expect(r.code).toBe('guard_mismatch');
    expect(r.current.id).toBe('fig:pipeline');
    expect(r.current.text).toContain('\\begin{figure}');
  });

  it('a \\ref to a missing label is refused; an unknown \\cite lands with a warning', async () => {
    const { env, mem, ver } = await setup();
    const bad = await call(
      h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'insert', target: { kind: 'find', text: 'two decades.' }, side: 'after', content: ' See Table~\\ref{tab:missing}.' }] }),
    );
    expect(bad.code).toBe('ref_unknown_label');
    expect(mem.docs.get('main.tex')!.version).toBe(0);
    const cite = await call(
      h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'insert', target: { kind: 'find', text: 'two decades.' }, side: 'after', content: ' \\citep{nobody2021}' }] }),
    );
    expect(cite.ok).toBe(true);
    expect(cite.warnings.map((w: { code: string }) => w.code)).toEqual(['cite_unknown']);
    expect(cite.warnings[0].detail).toMatch(/Report this to the user\.$/);
  });

  it('an unclosed figure is refused as compile_regression and nothing is sent', async () => {
    const { env, mem, ver } = await setup();
    const r = await call(
      h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'insert', target: { kind: 'unit', id: 'eq:kappa' }, side: 'after', content: '\\begin{figure}\n  \\centering\n  Oops.' }] }),
    );
    expect(r.code).toBe('compile_regression');
    expect(r.current.newErrors[0].message).toMatch(/begin\{figure\}/);
    expect(mem.docs.get('main.tex')!.version).toBe(0);
    // The mirror was restored.
    const sess = await env.ctx.sessions.get(P);
    expect(sess.mirror.read('main.tex')).toBe(mem.docs.get('main.tex')!.text);
  });

  it('a 40% replace is refused over_budget and succeeds with rewrite: true', async () => {
    const { env, ver, unit } = await setup();
    const u = await unit('main.tex/§1/¶2');
    const old = 'This paper asks what remains.\nWe describe a new corpus in Section~\\ref{sec:methods}.';
    const cut = Math.floor(old.length * 0.6);
    const replacement = old.slice(0, cut) + 'Q'.repeat(old.length - cut);
    const args = { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'replace' as const, target: { kind: 'unit' as const, id: u.id }, ifHash: u.hash, with: replacement }] };
    const refused = await call(h.update(env.ctx, args));
    expect(refused.code).toBe('over_budget');
    expect(refused.current.ratio).toBeGreaterThan(0.35);
    const ok = await call(h.update(env.ctx, { ...args, rewrite: true }));
    expect(ok.ok).toBe(true);
  });

  it('an edit while a coauthor types in another paragraph succeeds and both survive', async () => {
    const { env, mem, ver } = await setup();
    const v0 = ver();
    // Coauthor edits Introduction after the agent read the outline.
    const text = mem.docs.get('main.tex')!.text;
    const at = text.indexOf('Coverage has declined');
    mem.remoteEdit('main.tex', [{ start: at, end: at, text: 'Sadly, ' }]);
    // And keeps typing while the compile gate runs.
    env.runner.onCompile = () => {
      env.runner.onCompile = null;
      const t = mem.docs.get('main.tex')!.text;
      const k = t.indexOf('This paper asks');
      mem.remoteEdit('main.tex', [{ start: k, end: k, text: 'Now, ' }]);
    };
    const r = await call(
      h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: v0, ops: [{ op: 'replace', target: { kind: 'find', text: '12,000 articles' }, with: '\\nArticles{} articles' }] }),
    );
    expect(r.ok).toBe(true);
    const final = mem.docs.get('main.tex')!.text;
    expect(final).toContain('Sadly, Coverage has declined');
    expect(final).toContain('Now, This paper asks');
    expect(final).toContain('\\nArticles{} articles');
    expect(r.warnings.filter((w: { code: string }) => w.code === 'concurrent_edit')).toEqual([]);
  });

  it('warns concurrent_edit when a coauthor edits the target unit during the send window', async () => {
    const { env, mem, ver } = await setup();
    env.runner.onCompile = () => {
      env.runner.onCompile = null;
      const t = mem.docs.get('main.tex')!.text;
      const k = t.indexOf('from 40 outlets');
      mem.remoteEdit('main.tex', [{ start: k, end: k, text: 'roughly ' }]);
    };
    const r = await call(
      h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'replace', target: { kind: 'find', text: '12,000 articles' }, with: '\\nArticles{} articles' }] }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w: { code: string }) => w.code)).toContain('concurrent_edit');
    expect(mem.docs.get('main.tex')!.text).toContain('\\nArticles{} articles roughly from 40 outlets');
  });

  it('refuses an old ifVersion when the target unit changed since', async () => {
    const { env, mem } = await setup();
    const t = mem.docs.get('main.tex')!.text;
    const k = t.indexOf('from 40 outlets');
    mem.remoteEdit('main.tex', [{ start: k, end: k, text: 'roughly ' }]);
    const r = await call(h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: 0, ops: [{ op: 'replace', target: { kind: 'find', text: '12,000 articles' }, with: 'many articles' }] }));
    expect(r.code).toBe('guard_mismatch');
    expect(r.current.text).toContain('roughly from 40');
  });

  it('refuses tracked edits when tracking is unavailable, never sending untracked', async () => {
    const { env, mem, ver } = await setup('article', { trackChangesAvailable: false });
    const args = { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'insert' as const, target: { kind: 'find' as const, text: 'two decades.' }, side: 'after' as const, content: ' Indeed.' }] };
    expect((await call(h.update(env.ctx, args))).code).toBe('tracking_unavailable');
    expect(mem.docs.get('main.tex')!.version).toBe(0);
    expect((await call(h.update(env.ctx, { ...args, tracked: false }))).ok).toBe(true);
    expect(mem.docs.get('main.tex')!.ranges.changes).toEqual([]);
  });

  it('refuses preamble changes unless allowed', async () => {
    const { env, ver } = await setup();
    const args = { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'insert' as const, target: { kind: 'find' as const, text: '\\usepackage{hyperref}' }, side: 'after' as const, content: '\n\\usepackage{booktabs}' }] };
    const r = await call(h.update(env.ctx, args));
    expect(r.code).toBe('preamble_change');
    expect(r.current.added).toEqual(['\\usepackage{booktabs}']);
    expect((await call(h.update(env.ctx, { ...args, allowPreamble: true }))).ok).toBe(true);
  });

  it('refuses edits to generated files, naming the script', async () => {
    const env = makeEnv([project(P, 'generated')]);
    const r = await call(h.update(env.ctx, { projectId: P, file: 'numbers.tex', ifVersion: 0, ops: [{ op: 'replace', target: { kind: 'find', text: '40' }, with: '41' }] }));
    expect(r.code).toBe('generated_file');
    expect(r.detail).toContain('scripts/make_numbers.py');
  });

  it('warns parse_fallback and allows lines targets on fallback files', async () => {
    const env = makeEnv([project(P, 'journal')]);
    const o = await call(h.read(env.ctx, { kind: 'outline', projectId: P }));
    const hash = /id='main.tex\/¶9' h='([0-9a-f]+)'/.exec(o.outline)![1];
    const r = await call(h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: 0, ops: [{ op: 'replace', target: { kind: 'lines', start: 28, end: 28, ifHash: hash }, with: 'More texts.' }] }));
    // The journal fixture already fails to compile; pre-existing errors don't block.
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w: { code: string }) => w.code)).toContain('parse_fallback');
  });

  it('refuses a denylisted project', async () => {
    const env = makeEnv([project(P, 'article')], { denylist: [P] });
    expect((await call(h.read(env.ctx, { kind: 'outline', projectId: P }))).code).toBe('project_denied');
    expect((await call(h.read(env.ctx, { kind: 'projects' }))).projects).toEqual([]);
  });

  it('writes an audit record without document text beyond 200 chars', async () => {
    const { env, ver } = await setup();
    const long = 'word '.repeat(100);
    await call(h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'insert', target: { kind: 'unit', id: 'sec:results' }, side: 'after', content: long }] }));
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(env.cfg.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.tool === 'update');
    expect(rec.refusal).toBeNull();
    expect(rec.ops[0].content.length).toBeLessThan(260);
  });
});

describe('read', () => {
  it('reports a coauthor edit in read changes', async () => {
    const { env, mem, outline } = await setup();
    const t = mem.docs.get('main.tex')!.text;
    const k = t.indexOf('Codes followed');
    mem.remoteEdit('main.tex', [{ start: k, end: k, text: 'All ' }], 'user-coauthor');
    const r = await call(h.read(env.ctx, { kind: 'changes', projectId: P, sinceVersion: outline.ver }));
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0]).toMatchObject({ id: 'main.tex/§2.1/¶1', by: ['user-coauthor'] });
    expect(r.changed[0].text).toContain('All Codes followed');
  });

  it('returns resync_required when the log does not reach back', async () => {
    const env = makeEnv([project(P, 'article')], { changeLogSize: 1 });
    const mem = env.backend.projects.get(P) as MemoryProject;
    await call(h.read(env.ctx, { kind: 'outline', projectId: P }));
    for (const word of ['A ', 'B ']) {
      mem.remoteEdit('main.tex', [{ start: mem.docs.get('main.tex')!.text.indexOf('Codes'), end: mem.docs.get('main.tex')!.text.indexOf('Codes'), text: word }]);
      await (await env.ctx.sessions.get(P)).flush();
    }
    expect((await call(h.read(env.ctx, { kind: 'changes', projectId: P, sinceVersion: 0 }))).code).toBe('resync_required');
  });

  it('reads a unit with line numbers, search and bib', async () => {
    const { env } = await setup();
    const u = (await call(h.read(env.ctx, { kind: 'unit', projectId: P, id: 'eq:kappa' }))).unit;
    expect(u.source).toMatch(/^\s+44\| \\begin\{equation\}/);
    const s = await call(h.read(env.ctx, { kind: 'search', projectId: P, text: 'annotators' }));
    expect(s.matches[0]).toMatchObject({ unit: 'main.tex/§2/¶1', line: 33 });
    const b = await call(h.read(env.ctx, { kind: 'bib', projectId: P, key: 'smith2020' }));
    expect(b.entries[0].fields.publisher).toBe('Press');
  });
});

describe('batch (Phase 3)', () => {
  const rename = (ver: (f: string) => number) => ({
    projectId: P,
    edits: [
      { file: 'chapters/methods.tex', ifVersion: ver('chapters/methods.tex'), ops: [{ op: 'replace' as const, target: { kind: 'find' as const, text: '\\label{ch:methods}' }, with: '\\label{ch:method}' }] },
      { file: 'chapters/intro.tex', ifVersion: ver('chapters/intro.tex'), ops: [{ op: 'replace' as const, target: { kind: 'find' as const, text: '\\cref{ch:methods}' }, with: '\\cref{ch:method}' }] },
      { file: 'main.tex', ifVersion: ver('main.tex'), ops: [{ op: 'replace' as const, target: { kind: 'find' as const, text: '\\cref{ch:methods}' }, with: '\\cref{ch:method}' }] },
    ],
  });

  it('renames a label across three files', async () => {
    const { env, mem, ver } = await setup('thesis');
    const r = await call(h.batch(env.ctx, rename(ver)));
    expect(r.ok).toBe(true);
    for (const f of ['chapters/methods.tex', 'chapters/intro.tex', 'main.tex']) expect(mem.docs.get(f)!.text).toContain('ch:method}');
  });

  it('refuses the rename if a reference is left behind', async () => {
    const { env, ver } = await setup('thesis');
    const b = rename(ver);
    b.edits.pop();
    const r = await call(h.batch(env.ctx, b));
    expect(r.code).toBe('label_in_use');
    expect(r.current.referencedIn).toEqual(['main.tex']);
  });

  it('reverts sent edits when a later send fails', async () => {
    const { env, mem, ver } = await setup('thesis');
    const before = new Map([...mem.docs].map(([p, d]) => [p, d.text]));
    let sends = 0;
    const orig = mem.applyEdit.bind(mem);
    mem.applyEdit = async (...args) => {
      if (++sends === 3) throw new Error('socket closed');
      return orig(...args);
    };
    const r = await call(h.batch(env.ctx, rename(ver)));
    expect(r.code).toBe('batch_partial_reverted');
    expect(r.current.reverted.sort()).toEqual(['chapters/intro.tex', 'chapters/methods.tex']);
    for (const [p, t] of before) expect(mem.docs.get(p)!.text).toBe(t);
  });
});

describe('comments and review (Phase 3)', () => {
  async function review() {
    const files = loadFixture('review');
    const { ranges, threads } = loadRanges('review', files);
    const env = makeEnv([{ id: P, name: 'review', files, rootDoc: 'main.tex', ranges, threads }]);
    return { env, mem: env.backend.projects.get(P) as MemoryProject };
  }

  it('lists threads with unit IDs and marks comment text as data', async () => {
    const { env } = await review();
    const r = await call(h.comments(env.ctx, { projectId: P, action: 'list' }));
    expect(r.note).toMatch(/not instructions/);
    expect(r.threads[0]).toMatchObject({ unit: 'main.tex/§1/¶1', anchorText: 'consequences for civic engagement' });
    const o = await call(h.read(env.ctx, { kind: 'outline', projectId: P }));
    expect(o.outline).toContain("comments='1' tracked='1'");
  });

  it('creates a comment anchored on quoted words', async () => {
    const { env } = await review();
    const r = await call(h.comments(env.ctx, { projectId: P, action: 'create', anchor: { find: 'examine rural outlets', within: 'sec:discussion' }, body: 'Which outlets?' }));
    expect(r.ok).toBe(true);
    const list = await call(h.comments(env.ctx, { projectId: P, action: 'list', unit: 'main.tex/§1/¶2' }));
    expect(list.threads.map((t: { thread: string }) => t.thread)).toEqual([r.thread]);
    expect((await call(h.comments(env.ctx, { projectId: P, action: 'create', anchor: { find: 'rural' }, body: 'x' }))).code).toBe('invalid_op');
  });

  it('refuses resolve and review without askedInChat', async () => {
    const { env, mem } = await review();
    const thread = '6720f1c2a1b2c3d4e6000001';
    expect((await call(h.comments(env.ctx, { projectId: P, action: 'resolve', thread }))).code).toBe('resolve_not_requested');
    expect((await call(h.comments(env.ctx, { projectId: P, action: 'resolve', thread, askedInChat: true }))).resolved).toBe(true);
    const changeId = '6720f1c2a1b2c3d4e5000001';
    expect((await call(h.comments(env.ctx, { projectId: P, action: 'review', changeId, decision: 'reject' }))).code).toBe('review_not_requested');
    await call(h.comments(env.ctx, { projectId: P, action: 'review', changeId, decision: 'reject', askedInChat: true }));
    expect(mem.docs.get('main.tex')!.text).toContain('suggest that news coverage');
  });
});

describe('bib (Phase 3)', () => {
  it('adds an entry in key order as a tracked change', async () => {
    const { env, mem } = await setup();
    const r = await call(h.bib(env.ctx, { projectId: P, action: 'add', file: 'refs.bib', entry: '@article{jones2022,\n  author = {Jones, A.},\n  title = {Middle},\n  year = {2022}\n}' }));
    expect(r.ok).toBe(true);
    const t = mem.docs.get('refs.bib')!.text;
    expect(t.indexOf('hagar2024')).toBeLessThan(t.indexOf('jones2022'));
    expect(t.indexOf('jones2022')).toBeLessThan(t.indexOf('smith2020'));
    expect(mem.docs.get('refs.bib')!.ranges.changes).toHaveLength(1);
  });

  it('refuses duplicates and invalid entries; check reports keys', async () => {
    const { env } = await setup();
    expect((await call(h.bib(env.ctx, { projectId: P, action: 'add', file: 'refs.bib', entry: '@book{smith2020, title={X}}' }))).code).toBe('bib_duplicate_key');
    expect((await call(h.bib(env.ctx, { projectId: P, action: 'add', file: 'refs.bib', entry: '@book{x, title={X}' }))).code).toBe('bib_invalid');
    const c = await call(h.bib(env.ctx, { projectId: P, action: 'check', keys: ['doe2019', 'zzz'] }));
    expect(c.keys.map((k: { exists: boolean }) => k.exists)).toEqual([true, false]);
  });
});

describe('compile tool', () => {
  it('reports new errors and page images', async () => {
    const { env } = await setup();
    const r = await call(h.compile(env.ctx, { projectId: P, units: ['fig:pipeline'] }));
    expect(r).toMatchObject({ ok: true, status: 'ok', pdf: true, newErrors: [] });
    expect(r.pageImages[0].pages[0]).toMatch(/fig_pipeline-p1\.png$/);
  });

  it('lands edits with compile_skipped when the compiler is unavailable', async () => {
    const { env, ver } = await setup();
    env.runner.unavailableReason = 'Docker is not available';
    const r = await call(h.update(env.ctx, { projectId: P, file: 'main.tex', ifVersion: ver(), ops: [{ op: 'insert', target: { kind: 'find', text: 'two decades.' }, side: 'after', content: ' Indeed.' }] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w: { code: string }) => w.code)).toEqual(['compile_skipped']);
  });
});

describe('guide', () => {
  it('serves topics and refusal topics', () => {
    const env = makeEnv([]);
    const r = h.guide(env.ctx, ['topic.index', 'refusal.over_budget', 'topic.nope']);
    expect(r.topics['topic.index']).toMatch(/Tracked changes are the default/);
    expect(r.topics['refusal.over_budget']).toMatch(/rewrite/);
    expect(r.topics['topic.nope']).toMatch(/No topic/);
  });
});
