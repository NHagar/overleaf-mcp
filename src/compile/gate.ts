// Compile gate (spec §14): compile the mirror with a candidate edit and compare the log
// with the last baseline. New fatal errors refuse the edit; new warnings are reported.

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Config } from '../config.js';
import { isFatal, parseLog, type LogIssue } from './logparse.js';
import type { Mirror } from './mirror.js';
import { OUT_DIR, type CompileOptions, type CompileRunner } from './runner.js';

export interface GateSettings {
  rootDoc: string | null;
  compiler: string;
  texliveYear: string | null;
}

export interface CompileReport {
  status: 'ok' | 'skipped' | 'timeout';
  reason?: string;
  fatal: boolean;
  newErrors: LogIssue[];
  newWarnings: LogIssue[];
  pdf: boolean;
  logPath: string | null;
  durationMs: number;
}

interface Baseline {
  generation: number;
  keys: Set<string>;
}

export class CompileGate {
  private baseline: Baseline | null = null;

  constructor(
    private mirror: Mirror,
    private runner: CompileRunner,
    private settings: () => GateSettings,
    private cfg: Config['compile'],
  ) {}

  imageFor(year: string | null): string {
    return (year && this.cfg.images[year]) || this.cfg.defaultImage;
  }

  options(): CompileOptions | null {
    const s = this.settings();
    if (!s.rootDoc) return null;
    return { dir: this.mirror.dir, rootFile: s.rootDoc, compiler: s.compiler, image: this.imageFor(s.texliveYear), timeoutMs: this.cfg.timeoutSeconds * 1000 };
  }

  private async unavailable(): Promise<string | null> {
    if (!this.cfg.enabled) return 'Compile gate disabled in config.';
    if (!this.settings().rootDoc) return 'Project has no root document.';
    return this.runner.available();
  }

  private skipped(reason: string): CompileReport {
    return { status: 'skipped', reason, fatal: false, newErrors: [], newWarnings: [], pdf: false, logPath: null, durationMs: 0 };
  }

  /** Compile the mirror as it stands. Caller holds the mirror lock. */
  private async compileRaw(): Promise<{ issues: LogIssue[]; pdf: boolean; timedOut: boolean; durationMs: number; runnerError: string | null }> {
    const o = this.options()!;
    const out = await this.runner.compile(o);
    return { issues: parseLog(out.log), pdf: !!out.pdfPath, timedOut: out.timedOut, durationMs: out.durationMs, runnerError: out.runnerError };
  }

  logPath(): string | null {
    const s = this.settings();
    if (!s.rootDoc) return null;
    return join(this.mirror.dir, OUT_DIR, `${s.rootDoc.replace(/\.tex$/, '').split('/').pop()}.log`);
  }

  /** (Re)compute the baseline if the mirror changed since the last one. Caller holds the lock. */
  private async ensureBaseline(): Promise<string | null> {
    if (this.baseline && this.baseline.generation === this.mirror.generation) return null;
    const gen = this.mirror.generation;
    const r = await this.compileRaw();
    if (r.runnerError) return `Compiler failed to run: ${r.runnerError.trim().split('\n').slice(-3).join(' ')}`;
    if (r.timedOut) return 'Baseline compile timed out.';
    const keys = new Set(r.issues.map((i) => i.key));
    if (!r.pdf) keys.add('__no_pdf__');
    this.baseline = { generation: gen, keys };
    return null;
  }

  private diff(issues: LogIssue[], pdf: boolean) {
    const base = this.baseline?.keys ?? new Set<string>();
    const fresh = issues.filter((i) => !base.has(i.key));
    const newErrors = fresh.filter((i) => i.severity === 'error');
    const baseHadNoPdf = base.has('__no_pdf__');
    if (!pdf && !baseHadNoPdf) newErrors.push({ severity: 'error', kind: 'no-pdf', file: null, line: null, message: 'No PDF was produced.', context: null, key: '__no_pdf__' });
    return { newErrors, newWarnings: fresh.filter((i) => i.severity === 'warning') };
  }

  /**
   * Writes candidate texts into the mirror, compiles, and restores the previous texts.
   * On success the baseline moves to the candidate's issue set (the edit is about to land).
   */
  async check(candidates: Map<string, string>): Promise<CompileReport> {
    const why = await this.unavailable();
    if (why) return this.skipped(why);
    return this.mirror.lock.run(async () => {
      const baseErr = await this.ensureBaseline();
      if (baseErr) return this.skipped(baseErr);
      const previous = new Map<string, string | null>();
      const generation = this.mirror.generation;
      for (const [p, t] of candidates) {
        previous.set(p, this.mirror.read(p));
        this.mirror.write(p, t);
      }
      try {
        const r = await this.compileRaw();
        if (r.timedOut) return { ...this.skipped('Compile timed out.'), status: 'timeout' as const, durationMs: r.durationMs };
        if (r.runnerError) return this.skipped(`Compiler failed to run: ${r.runnerError.trim().split('\n').slice(-3).join(' ')}`);
        const { newErrors, newWarnings } = this.diff(r.issues, r.pdf);
        const fatal = newErrors.length > 0;
        if (!fatal) {
          // Becomes the baseline once the edit lands and the mirror holds the new text.
          this.pendingBaseline = new Set(r.issues.map((i) => i.key));
          if (!r.pdf) this.pendingBaseline.add('__no_pdf__');
        }
        return { status: 'ok', fatal, newErrors, newWarnings, pdf: r.pdf, logPath: this.logPath(), durationMs: r.durationMs };
      } finally {
        for (const [p, t] of previous) {
          if (t === null) this.mirror.remove(p);
          else this.mirror.write(p, t);
        }
        // Content is back to what the baseline saw; all mirror writes hold the lock.
        this.mirror.generation = generation;
      }
    });
  }

  private pendingBaseline: Set<string> | null = null;

  /** After an agent edit lands (mirror updated): the candidate's issues become the baseline. */
  adoptPendingBaseline(): void {
    if (this.pendingBaseline) this.baseline = { generation: this.mirror.generation, keys: this.pendingBaseline };
    this.pendingBaseline = null;
  }

  discardPendingBaseline(): void {
    this.pendingBaseline = null;
  }

  /** Compile the current mirror and report what is new relative to the baseline (the `compile` tool). */
  async compileCurrent(): Promise<CompileReport & { issues: LogIssue[] }> {
    const why = await this.unavailable();
    if (why) return { ...this.skipped(why), issues: [] };
    return this.mirror.lock.run(async () => {
      if (!this.baseline) {
        const err = await this.ensureBaseline();
        if (err) return { ...this.skipped(err), issues: [] };
      }
      const r = await this.compileRaw();
      if (r.timedOut) return { ...this.skipped('Compile timed out.'), status: 'timeout' as const, issues: [] };
      if (r.runnerError) return { ...this.skipped(`Compiler failed to run: ${r.runnerError}`), issues: [] };
      const { newErrors, newWarnings } = this.diff(r.issues, r.pdf);
      if (!newErrors.length) {
        const keys = new Set(r.issues.map((i) => i.key));
        if (!r.pdf) keys.add('__no_pdf__');
        this.baseline = { generation: this.mirror.generation, keys };
      }
      return { status: 'ok', fatal: newErrors.length > 0, newErrors, newWarnings, pdf: r.pdf, logPath: this.logPath(), durationMs: r.durationMs, issues: r.issues };
    });
  }

  async pageImages(file: string, lines: number[], tag: string): Promise<string[]> {
    const o = this.options();
    if (!o || (await this.unavailable())) return [];
    return this.mirror.lock.run(async () => {
      const base = o.rootFile.replace(/\.tex$/, '').split('/').pop()!;
      const pdf = join(this.mirror.dir, OUT_DIR, `${base}.pdf`);
      const pages = await this.runner.synctexPages(o, file, lines);
      const dir = join(this.mirror.dir, OUT_DIR, 'pages');
      mkdirSync(dir, { recursive: true });
      return this.runner.renderPages(o, pdf, pages, join(dir, tag.replace(/[^\w.-]+/g, '_')));
    });
  }
}

export { isFatal };
