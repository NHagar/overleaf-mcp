// Runs latexmk, synctex and pdftoppm inside a TeX Live Docker image.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUT_DIR = '.overleaf-mcp-out';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(cmd: string, args: string[], timeoutMs: number, onTimeout?: () => void): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export interface CompileOptions {
  dir: string;
  rootFile: string;
  compiler: string;
  image: string;
  timeoutMs: number;
}

export interface CompileOutput {
  log: string;
  pdfPath: string | null;
  timedOut: boolean;
  durationMs: number;
  runnerError: string | null;
}

export interface CompileRunner {
  available(): Promise<string | null>; // null = ok, else reason
  compile(o: CompileOptions): Promise<CompileOutput>;
  synctexPages(o: CompileOptions, file: string, lines: number[]): Promise<number[]>;
  renderPages(o: CompileOptions, pdfPath: string, pages: number[], outPrefix: string): Promise<string[]>;
}

const ENGINE_FLAG: Record<string, string> = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua', latex: '-pdfdvi' };

export class DockerRunner implements CompileRunner {
  private availability: Promise<string | null> | null = null;
  constructor(private docker = 'docker') {}

  available(): Promise<string | null> {
    this.availability ??= run(this.docker, ['info', '--format', '{{.ServerVersion}}'], 15000).then((r) =>
      r.code === 0 ? null : `Docker is not available (${(r.stderr || r.stdout).trim().split('\n')[0] || 'no response'})`,
    );
    return this.availability;
  }

  private dockerArgs(o: CompileOptions, name: string, cmd: string[]): string[] {
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    return ['run', '--rm', '--name', name, '--network', 'none', '--user', `${uid}:${gid}`, '-e', 'HOME=/tmp', '-v', `${o.dir}:/work`, '-w', '/work', o.image, ...cmd];
  }

  async compile(o: CompileOptions): Promise<CompileOutput> {
    const t0 = Date.now();
    const name = `overleaf-mcp-${randomBytes(4).toString('hex')}`;
    const cmd = ['latexmk', ENGINE_FLAG[o.compiler] ?? '-pdf', '-f', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', `-outdir=${OUT_DIR}`, o.rootFile];
    const r = await run(this.docker, this.dockerArgs(o, name, cmd), o.timeoutMs, () => {
      void run(this.docker, ['kill', name], 10000);
    });
    const base = o.rootFile.replace(/\.tex$/, '').split('/').pop()!;
    const logPath = join(o.dir, OUT_DIR, `${base}.log`);
    const pdfPath = join(o.dir, OUT_DIR, `${base}.pdf`);
    const log = existsSync(logPath) ? readFileSync(logPath, 'latin1') : '';
    const runnerError = !log && !r.timedOut ? (r.stderr || r.stdout).slice(-2000) : null;
    return { log, pdfPath: existsSync(pdfPath) ? pdfPath : null, timedOut: r.timedOut, durationMs: Date.now() - t0, runnerError };
  }

  async synctexPages(o: CompileOptions, file: string, lines: number[]): Promise<number[]> {
    const base = o.rootFile.replace(/\.tex$/, '').split('/').pop()!;
    const pages = new Set<number>();
    for (const line of lines) {
      const cmd = ['synctex', 'view', '-i', `${line}:0:/work/${file}`, '-o', `/work/${OUT_DIR}/${base}.pdf`];
      const r = await run(this.docker, this.dockerArgs(o, `overleaf-mcp-${randomBytes(4).toString('hex')}`, cmd), 60000);
      for (const m of r.stdout.matchAll(/^Page:(\d+)/gm)) pages.add(Number(m[1]));
    }
    return [...pages].sort((a, b) => a - b);
  }

  async renderPages(o: CompileOptions, pdfPath: string, pages: number[], outPrefix: string): Promise<string[]> {
    const out: string[] = [];
    const hostPdftoppm = await run('pdftoppm', ['-v'], 5000);
    for (const p of pages) {
      const prefix = `${outPrefix}-p${p}`;
      if (hostPdftoppm.code === 0 || /pdftoppm version/.test(hostPdftoppm.stderr)) {
        await run('pdftoppm', ['-png', '-r', '110', '-f', String(p), '-l', String(p), '-singlefile', pdfPath, prefix], 60000);
      } else {
        const rel = (s: string) => s.replace(o.dir, '/work');
        await run(this.docker, this.dockerArgs(o, `overleaf-mcp-${randomBytes(4).toString('hex')}`, ['pdftoppm', '-png', '-r', '110', '-f', String(p), '-l', String(p), '-singlefile', rel(pdfPath), rel(prefix)]), 60000);
      }
      if (existsSync(`${prefix}.png`)) out.push(`${prefix}.png`);
    }
    return out;
  }
}
