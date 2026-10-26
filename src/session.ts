// One open project: cached doc states, the outline, the change log, the local mirror and the
// compile gate. Incoming changes are coalesced and folded in shortly after they arrive.

import type { Backend, DocState, IncomingChange, ProjectHandle } from './adapters/adapter.js';
import { ChangeLog, diffUnitMaps } from './feed/changelog.js';
import { CompileGate } from './compile/gate.js';
import { Mirror } from './compile/mirror.js';
import type { CompileRunner } from './compile/runner.js';
import { expandHome, type Config } from './config.js';
import { Refusal } from './errors.js';
import { buildProjectOutline, type ProjectOutline } from './model/outline.js';

export interface SessionEntry {
  ver: number;
  file: string;
  docVersion: number;
  changed: string[];
  deleted: string[];
  by: string[];
}

const TEXT_DOC = /\.(tex|ltx|sty|cls|bib|bbl|txt|md|cfg|def|bst)$/i;

export class ProjectSession {
  docs = new Map<string, DocState>();
  outline!: ProjectOutline;
  readonly changelog: ChangeLog;
  /** Doc version recorded with each change-log entry, for ifVersion freshness checks. */
  private docVersionAt = new Map<number, { file: string; docVersion: number; ids: Set<string> }>();
  /** Per file, the oldest doc version whose later changes the log fully covers. */
  private knownFrom = new Map<string, number>();
  readonly mirror: Mirror;
  readonly gate: CompileGate;
  private pending = new Map<string, Set<string>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly handle: ProjectHandle,
    readonly cfg: Config,
    runner: CompileRunner,
    readonly debounceMs = 150,
  ) {
    this.changelog = new ChangeLog(cfg.changeLogSize);
    this.mirror = Mirror.forProject(expandHome(cfg.compile.mirrorDir), handle.projectId);
    this.gate = new CompileGate(
      this.mirror,
      runner,
      () => {
        const s = handle.settings();
        return { rootDoc: s.rootDoc, compiler: s.compiler, texliveYear: s.texliveYear };
      },
      cfg.compile,
    );
  }

  get projectId() {
    return this.handle.projectId;
  }

  async init(): Promise<void> {
    for (const e of this.handle.tree()) {
      if (e.kind === 'doc') {
        const d = await this.handle.readDoc(e.path);
        this.docs.set(e.path, d);
        this.knownFrom.set(e.path, d.version);
        await this.mirror.lock.run(async () => this.mirror.write(e.path, d.text));
      } else {
        try {
          const b = await this.handle.readBinary(e.path);
          await this.mirror.lock.run(async () => this.mirror.write(e.path, b));
        } catch {
          // A missing binary only weakens the compile gate.
        }
      }
    }
    this.rebuild();
    this.unsubscribe = this.handle.onChange((c) => this.onChange(c));
  }

  private rebuild(): ProjectOutline {
    const texts = [...this.docs.values()].map((d) => ({ path: d.path, text: d.text }));
    this.outline = buildProjectOutline(texts, this.handle.settings().rootDoc);
    return this.outline;
  }

  private onChange(c: IncomingChange) {
    const by = c.source === 'self' ? ['agent'] : c.userIds.length ? c.userIds : ['unknown'];
    const set = this.pending.get(c.path) ?? new Set<string>();
    for (const u of by) set.add(u);
    this.pending.set(c.path, set);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Folds pending changes into docs, mirror, outline and change log. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // A failed flush must not poison later ones; its batch is re-queued by doFlush.
    const run = this.flushing.catch(() => undefined).then(() => this.doFlush());
    this.flushing = run;
    return run;
  }

  private async doFlush() {
    if (!this.pending.size) return;
    const batch = this.pending;
    this.pending = new Map();
    try {
      await this.applyBatch(batch);
    } catch (err) {
      for (const [p, by] of batch) {
        const set = this.pending.get(p) ?? new Set<string>();
        for (const u of by) set.add(u);
        this.pending.set(p, set);
      }
      throw err;
    }
  }

  private async applyBatch(batch: Map<string, Set<string>>) {
    const before = this.outline;
    const beforeMaps = unitMaps(before);
    const known = new Set(this.handle.tree().map((e) => e.path));
    for (const path of batch.keys()) {
      if (!known.has(path)) {
        this.docs.delete(path);
        await this.mirror.lock.run(async () => this.mirror.remove(path));
        continue;
      }
      const entry = this.handle.tree().find((e) => e.path === path)!;
      if (entry.kind === 'binary') {
        const b = await this.handle.readBinary(path).catch(() => null);
        if (b) await this.mirror.lock.run(async () => this.mirror.write(path, b));
        continue;
      }
      const d = await this.handle.readDoc(path);
      this.docs.set(path, d);
      await this.mirror.lock.run(async () => this.mirror.write(path, d.text));
    }
    const after = this.rebuild();
    const afterMaps = unitMaps(after);
    const files = new Set([...beforeMaps.keys(), ...afterMaps.keys()]);
    for (const file of files) {
      const { changed, deleted } = diffUnitMaps(beforeMaps.get(file) ?? new Map(), afterMaps.get(file) ?? new Map());
      const touched = batch.has(file);
      if (!changed.length && !deleted.length && !touched) continue;
      const by = [...(batch.get(file) ?? new Set(['agent']))];
      const ver = this.changelog.record(file, changed, deleted, by);
      this.docVersionAt.set(ver, { file, docVersion: this.docs.get(file)?.version ?? 0, ids: new Set([...changed, ...deleted]) });
      if (!this.knownFrom.has(file)) this.knownFrom.set(file, 0);
      while (this.docVersionAt.size > this.cfg.changeLogSize) {
        const [oldest, v] = this.docVersionAt.entries().next().value!;
        this.docVersionAt.delete(oldest);
        this.knownFrom.set(v.file, Math.max(this.knownFrom.get(v.file) ?? 0, v.docVersion));
      }
    }
  }

  doc(path: string): DocState {
    const d = this.docs.get(path);
    if (!d) {
      const entry = this.handle.tree().find((e) => e.path === path);
      throw new Refusal('not_a_doc', entry ? `${path} is a binary file, not a text doc.` : `No file ${path} in this project.`, {
        files: this.handle.tree().map((e) => `${e.path} (${e.kind})`),
      });
    }
    return d;
  }

  /**
   * Unit IDs in `file` that changed after the given doc version, or null if the log no
   * longer reaches back that far.
   */
  changedSinceDocVersion(file: string, docVersion: number): Set<string> | null {
    if (docVersion < (this.knownFrom.get(file) ?? 0)) return null;
    const out = new Set<string>();
    for (const v of this.docVersionAt.values()) if (v.file === file && v.docVersion > docVersion) for (const id of v.ids) out.add(id);
    return out;
  }

  bibs(): Map<string, string> {
    const m = new Map<string, string>();
    for (const [p, d] of this.docs) if (p.toLowerCase().endsWith('.bib')) m.set(p, d.text);
    return m;
  }

  async close() {
    this.unsubscribe?.();
    await this.handle.close();
  }
}

function unitMaps(o: ProjectOutline): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const f of o.files.values()) out.set(f.path, new Map(f.units.map((u) => [u.id, u.hash])));
  return out;
}

export class SessionManager {
  private sessions = new Map<string, Promise<ProjectSession>>();

  constructor(
    private backend: Backend,
    private cfg: Config,
    private runner: CompileRunner,
    private debounceMs = 150,
  ) {}

  assertAllowed(projectId: string) {
    if (this.cfg.denylist.includes(projectId)) throw new Refusal('project_denied', `Project ${projectId} is excluded by the server's denylist.`);
  }

  get(projectId: string): Promise<ProjectSession> {
    this.assertAllowed(projectId);
    let s = this.sessions.get(projectId);
    if (!s) {
      s = (async () => {
        const handle = await this.backend.openProject(projectId);
        const sess = new ProjectSession(handle, this.cfg, this.runner, this.debounceMs);
        await sess.init();
        return sess;
      })();
      s.catch(() => this.sessions.delete(projectId));
      this.sessions.set(projectId, s);
    }
    return s;
  }

  async closeAll() {
    for (const s of this.sessions.values()) await (await s.catch(() => null))?.close();
    this.sessions.clear();
  }
}

export { TEXT_DOC };
