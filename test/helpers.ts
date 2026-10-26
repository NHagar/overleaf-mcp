import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ranges, CommentThread } from '../src/adapters/adapter.js';
import { MemoryBackend, type MemoryProjectSpec } from '../src/adapters/memory/index.js';
import { AuditLog } from '../src/audit/log.js';
import { OUT_DIR, type CompileOptions, type CompileOutput, type CompileRunner } from '../src/compile/runner.js';
import { parseConfig, type Config } from '../src/config.js';
import { Refusal } from '../src/errors.js';
import { SessionManager } from '../src/session.js';
import type { Ctx } from '../src/tools/handlers.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const META = new Set(['expected-outline.xml', 'ranges.json', 'threads.json']);

export function loadFixture(name: string): Record<string, string> {
  const root = join(FIXTURES, name);
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (!META.has(e)) out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** Fixture 5 stores ranges by quoted text; resolve them to positions. */
export function loadRanges(name: string, files: Record<string, string>): { ranges: Record<string, Ranges>; threads: CommentThread[] } {
  const root = join(FIXTURES, name);
  const ranges: Record<string, Ranges> = {};
  if (existsSync(join(root, 'ranges.json'))) {
    const raw = JSON.parse(readFileSync(join(root, 'ranges.json'), 'utf8')) as Record<string, { changes: any[]; comments: any[] }>;
    for (const [p, r] of Object.entries(raw)) {
      ranges[p] = {
        changes: r.changes.map(({ find, ...c }) => ({ ...c, pos: files[p].indexOf(find) })),
        comments: r.comments.map(({ find, ...c }) => ({ ...c, pos: files[p].indexOf(find) })),
      };
    }
  }
  const threads = existsSync(join(root, 'threads.json')) ? JSON.parse(readFileSync(join(root, 'threads.json'), 'utf8')) : [];
  return { ranges, threads };
}

/**
 * Stand-in for latexmk: reports unbalanced environments and braces as LaTeX errors in
 * -file-line-error form, and "produces" a PDF when there are none. `onCompile` lets a test
 * act while a compile is running (e.g. simulate a coauthor typing).
 */
export class FakeRunner implements CompileRunner {
  compiles = 0;
  onCompile: (() => void) | null = null;
  unavailableReason: string | null = null;

  async available() {
    return this.unavailableReason;
  }

  async compile(o: CompileOptions): Promise<CompileOutput> {
    this.compiles++;
    this.onCompile?.();
    const log: string[] = ['This is fake pdfTeX'];
    const visit = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (e === OUT_DIR) continue;
        if (statSync(p).isDirectory()) visit(p);
        else if (e.endsWith('.tex')) {
          const rel = relative(o.dir, p);
          const lines = readFileSync(p, 'utf8').split('\n');
          const stack: { name: string; line: number }[] = [];
          let verbatim = false;
          lines.forEach((l, i) => {
            if (verbatim) {
              verbatim = !/\\end\{verbatim\}/.test(l);
              return;
            }
            if (/\\begin\{verbatim\}/.test(l)) {
              verbatim = true;
              return;
            }
            const code = l.replace(/(^|[^\\])%.*$/, '$1');
            for (const m of code.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
              if (m[1] === 'begin') stack.push({ name: m[2], line: i + 1 });
              else {
                const top = stack.pop();
                if (!top || top.name !== m[2]) {
                  log.push(`./${rel}:${i + 1}: LaTeX Error: \\begin{${top?.name ?? '?'}} on input line ${top?.line ?? 0} ended by \\end{${m[2]}}.`, `l.${i + 1} ${l}`);
                }
              }
            }
            if (/\\undefinedmacro/.test(code)) log.push(`./${rel}:${i + 1}: Undefined control sequence.`, `l.${i + 1} ${l}`);
            if (/\\overfull/.test(code)) log.push(`Overfull \\hbox (12.3pt too wide) in paragraph at lines ${i + 1}--${i + 1}`);
          });
          for (const s of stack) log.push(`./${rel}:${lines.length}: LaTeX Error: \\begin{${s.name}} on input line ${s.line} ended by \\end{document}.`, `l.${lines.length} \\end{document}`);
        }
      }
    };
    visit(o.dir);
    const out = join(o.dir, OUT_DIR);
    mkdirSync(out, { recursive: true });
    const base = o.rootFile.replace(/\.tex$/, '');
    writeFileSync(join(out, `${base}.log`), log.join('\n'));
    const hasError = log.some((l) => /^\.\/.*:\d+: /.test(l));
    if (!hasError) writeFileSync(join(out, `${base}.pdf`), '%PDF-fake');
    return { log: log.join('\n'), pdfPath: hasError ? null : join(out, `${base}.pdf`), timedOut: false, durationMs: 1, runnerError: null };
  }

  async synctexPages() {
    return [1];
  }

  async renderPages(_o: CompileOptions, _pdf: string, pages: number[], prefix: string) {
    return pages.map((p) => {
      mkdirSync(dirname(prefix), { recursive: true });
      writeFileSync(`${prefix}-p${p}.png`, 'png');
      return `${prefix}-p${p}.png`;
    });
  }
}

export interface TestEnv {
  ctx: Ctx;
  backend: MemoryBackend;
  runner: FakeRunner;
  cfg: Config;
  tmp: string;
}

export function makeEnv(specs: MemoryProjectSpec[], cfgOverrides: Record<string, unknown> = {}): TestEnv {
  const tmp = mkdtempSync(join(tmpdir(), 'overleaf-mcp-test-'));
  const cfg = parseConfig({ compile: { mirrorDir: join(tmp, 'mirrors') }, auditLog: join(tmp, 'audit.jsonl'), ...cfgOverrides });
  const backend = new MemoryBackend(specs);
  const runner = new FakeRunner();
  const ctx: Ctx = { backend, cfg, sessions: new SessionManager(backend, cfg, runner, 5), audit: new AuditLog(cfg.auditLog) };
  return { ctx, backend, runner, cfg, tmp };
}

/** Runs a handler and returns its value, or the refusal's JSON shape. */
export async function call<T>(p: Promise<T>): Promise<any> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof Refusal) return err.toJSON();
    throw err;
  }
}

export function project(id: string, fixture: string, extra: Partial<MemoryProjectSpec> = {}): MemoryProjectSpec {
  const files = loadFixture(fixture);
  return { id, name: fixture, files, rootDoc: 'main.tex', ...extra };
}
