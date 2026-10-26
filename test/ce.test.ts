// Integration against a running Overleaf Community Edition. Opt-in:
//   CE_URL=http://localhost:8090 CE_COOKIE_FILE=… CE_PROJECT=… npx vitest run test/ce.test.ts
// Uses real latexmk in Docker (TEXLIVE_IMAGE, default texlive/texlive:latest-small).
// It edits the project; use a scratch one.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeBackend, type RealtimeProject } from '../src/adapters/realtime/backend.js';
import { AuditLog } from '../src/audit/log.js';
import { DockerRunner, type CompileOptions } from '../src/compile/runner.js';
import { SessionManager } from '../src/session.js';
import * as h from '../src/tools/handlers.js';
import { call, makeEnv } from './helpers.js';

const url = process.env.CE_URL;
const enabled = !!(url && process.env.CE_COOKIE_FILE && process.env.CE_PROJECT);

describe.skipIf(!enabled)('Overleaf Community Edition', () => {
  const pid = process.env.CE_PROJECT!;
  const cookie = enabled ? readFileSync(process.env.CE_COOKIE_FILE!, 'utf8').trim() : '';
  let coauthor: RealtimeProject;
  let ctx: h.Ctx;
  const runner = new DockerRunner();
  let duringCompile: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const env = makeEnv([], { compile: { defaultImage: process.env.TEXLIVE_IMAGE ?? 'texlive/texlive:latest-small', images: {}, timeoutSeconds: 300 } });
    const backend = new RealtimeBackend(url!, cookie);
    const hooked = Object.create(runner) as DockerRunner;
    hooked.compile = async (o: CompileOptions) => {
      const out = runner.compile(o);
      if (duringCompile) {
        const f = duringCompile;
        duringCompile = null;
        await f();
      }
      return out;
    };
    ctx = { backend, cfg: env.cfg, sessions: new SessionManager(backend, env.cfg, hooked, 50), audit: new AuditLog(env.cfg.auditLog) };
    // A second connection plays the coauthor typing in a browser.
    coauthor = (await new RealtimeBackend(url!, cookie).openProject(pid)) as RealtimeProject;
  }, 120_000);

  afterAll(async () => {
    await coauthor?.close();
    await ctx?.sessions.closeAll();
  });

  const coauthorInsert = async (before: string, text: string) => {
    const d = await coauthor.readDoc('main.tex');
    const at = d.text.indexOf(before);
    if (at === -1) throw new Error(`coauthor anchor not found: ${before}`);
    await coauthor.applyEdit('main.tex', { baseText: d.text, splices: [{ start: at, end: at, text }] }, { baseVersion: d.version, tracked: false });
  };

  it('reads the outline and sees a coauthor edit in read changes within 5 s', async () => {
    const o = await call(h.read(ctx, { kind: 'outline', projectId: pid }));
    expect(o.outline).toContain("<file path='main.tex'");
    await coauthorInsert("Once you're familiar", 'Coauthor was here. ');
    const t0 = Date.now();
    let changed: { text: string; by: string[] }[] = [];
    while (Date.now() - t0 < 5000 && !changed.length) {
      await new Promise((r) => setTimeout(r, 100));
      changed = (await call(h.read(ctx, { kind: 'changes', projectId: pid, sinceVersion: o.ver }))).changed;
    }
    expect(changed.some((u) => u.text.includes('Coauthor was here.'))).toBe(true);
  }, 120_000);

  it('refuses tracked edits on CE (review UI hidden) and lands untracked ones through the full pipeline', async () => {
    const sess = await ctx.sessions.get(pid);
    const ver = () => sess.docs.get('main.tex')!.version;
    const op = { op: 'insert' as const, target: { kind: 'find' as const, text: 'Your introduction goes here!' }, side: 'before' as const, content: 'Agent was here too. ' };
    expect((await call(h.update(ctx, { projectId: pid, file: 'main.tex', ifVersion: ver(), ops: [op] }))).code).toBe('tracking_unavailable');
    // A coauthor edits elsewhere while the compile gate runs.
    duringCompile = () => coauthorInsert('\\section{Introduction}', '% coauthor comment line\n');
    const r = await call(h.update(ctx, { projectId: pid, file: 'main.tex', ifVersion: ver(), tracked: false, ops: [op] }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await sess.flush();
    const text = sess.docs.get('main.tex')!.text;
    expect(text).toContain('Agent was here too. Your introduction goes here!');
    expect(text).toContain('% coauthor comment line\n\\section{Introduction}');
    const server = await coauthor.readDoc('main.tex');
    expect(server.text).toBe(text);
  }, 600_000);

  it('refuses a stale hash, a dangling \\ref, and an unclosed environment', async () => {
    const sess = await ctx.sessions.get(pid);
    await sess.flush();
    const ver = sess.docs.get('main.tex')!.version;
    const first = sess.outline.files.get('main.tex')!.units.find((u) => u.kind === 'paragraph')!;
    const stale = await call(h.update(ctx, { projectId: pid, file: 'main.tex', ifVersion: ver, tracked: false, ops: [{ op: 'replace', target: { kind: 'unit', id: first.id }, ifHash: '00000000', with: 'x' }] }));
    expect(['guard_mismatch', 'unit_not_found']).toContain(stale.code);
    const ref = await call(h.update(ctx, { projectId: pid, file: 'main.tex', ifVersion: ver, tracked: false, ops: [{ op: 'insert', target: { kind: 'find', text: 'Your introduction goes here!' }, side: 'before', content: 'See \\ref{nope}. ' }] }));
    expect(ref.code).toBe('ref_unknown_label');
    const env = await call(
      h.update(ctx, { projectId: pid, file: 'main.tex', ifVersion: ver, tracked: false, ops: [{ op: 'insert', target: { kind: 'find', text: 'Your introduction goes here!' }, side: 'before', content: '\\begin{itemize}\n\\item x\n' }] }),
    );
    expect(env.code, JSON.stringify(env)).toBe('compile_regression');
  }, 600_000);
});
