// Real latexmk in Docker. Opt-in: DOCKER_TESTS=1 TEXLIVE_IMAGE=texlive/texlive:latest-small npx vitest run test/docker.test.ts

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MemoryProject } from '../src/adapters/memory/index.js';
import { DockerRunner } from '../src/compile/runner.js';
import { SessionManager } from '../src/session.js';
import * as h from '../src/tools/handlers.js';
import { call, makeEnv } from './helpers.js';

const enabled = process.env.DOCKER_TESTS === '1';
const image = process.env.TEXLIVE_IMAGE ?? 'texlive/texlive:latest-small';

const MAIN = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}

\\section{Intro}
\\label{sec:intro}

Some text that refers to Section~\\ref{sec:intro}.

\\begin{equation}
  E = mc^2
  \\label{eq:e}
\\end{equation}

\\end{document}
`;

describe.skipIf(!enabled)('compile gate with real latexmk', () => {
  it('builds a baseline, refuses a regression, renders unit pages', async () => {
    const env = makeEnv([{ id: 'p1', name: 'real', files: { 'main.tex': MAIN }, rootDoc: 'main.tex' }], {
      compile: { defaultImage: image, images: {}, timeoutSeconds: 180 },
    });
    const runner = new DockerRunner();
    env.ctx.sessions = new SessionManager(env.backend, env.cfg, runner, 5);
    const mem = env.backend.projects.get('p1') as MemoryProject;

    const bad = await call(
      h.update(env.ctx, { projectId: 'p1', file: 'main.tex', ifVersion: 0, ops: [{ op: 'insert', target: { kind: 'unit', id: 'eq:e' }, side: 'after', content: '\\begin{figure}\n  Unclosed.' }] }),
    );
    expect(bad.code).toBe('compile_regression');
    expect(JSON.stringify(bad.current.newErrors)).toMatch(/figure/);
    expect(mem.docs.get('main.tex')!.version).toBe(0);

    const good = await call(
      h.update(env.ctx, { projectId: 'p1', file: 'main.tex', ifVersion: 0, ops: [{ op: 'replace', target: { kind: 'find', text: 'Some text' }, with: 'Some more text' }] }),
    );
    expect(good.ok).toBe(true);
    expect(good.warnings).toEqual([]);

    const c = await call(h.compile(env.ctx, { projectId: 'p1', units: ['eq:e'] }));
    expect(c.status).toBe('ok');
    expect(c.pdf).toBe(true);
    expect(c.pageImages[0].pages.length).toBeGreaterThan(0);
    expect(existsSync(c.pageImages[0].pages[0])).toBe(true);
  }, 600_000);
});
