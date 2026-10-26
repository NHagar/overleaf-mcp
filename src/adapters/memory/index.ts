// In-memory Backend for tests and local experiments. It mimics the parts of Overleaf the
// server relies on: versions, server-side rebasing of stale edits, tracked-change ranges,
// comments, and change events.

import { randomBytes } from 'node:crypto';
import {
  BackendError,
  type Backend,
  type CommentApi,
  type CommentThread,
  type DocState,
  type EditReceipt,
  type FileEntry,
  type IncomingChange,
  type ProjectHandle,
  type ProjectSettings,
  type ProjectSummary,
  type Ranges,
  type Splice,
  type TextEdit,
} from '../adapter.js';

export interface MemoryProjectSpec {
  id: string;
  name: string;
  files: Record<string, string | Buffer>;
  rootDoc?: string;
  compiler?: ProjectSettings['compiler'];
  texliveYear?: string | null;
  trackChangesAvailable?: boolean;
  ranges?: Record<string, Ranges>;
  threads?: CommentThread[];
}

interface Doc {
  id: string;
  text: string;
  version: number;
  ranges: Ranges;
  /** Splices applied at each version (index = version they were applied at). */
  history: Splice[][];
  otType: string;
}

function seed(): string {
  return randomBytes(9).toString('hex');
}

/** Maps an offset through splices applied to the same base text. */
function mapThrough(splices: Splice[], pos: number, assoc: 'left' | 'right'): number {
  let delta = 0;
  for (const s of [...splices].sort((a, b) => a.start - b.start)) {
    const growth = s.text.length - (s.end - s.start);
    if (s.start === s.end && s.start === pos) {
      if (assoc === 'right') delta += growth;
    } else if (s.end <= pos) delta += growth;
    else if (s.start < pos) return s.start + delta + (assoc === 'right' ? s.text.length : 0);
    else break;
  }
  return pos + delta;
}

function applyAll(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

export class MemoryProject implements ProjectHandle {
  docs = new Map<string, Doc>();
  binaries = new Map<string, Buffer>();
  threads = new Map<string, CommentThread>();
  private listeners = new Set<(c: IncomingChange) => void>();
  /** Test hook: called after an edit is applied but before applyEdit resolves. */
  afterApply: ((path: string) => void) | null = null;
  failNextEdit: string | null = null;

  constructor(
    public projectId: string,
    private spec: MemoryProjectSpec,
    public userId = 'user-agent',
  ) {
    for (const [p, c] of Object.entries(spec.files)) {
      if (typeof c === 'string') this.docs.set(p, { id: seed().slice(0, 24), text: c, version: 0, ranges: { changes: [], comments: [] }, history: [], otType: 'sharejs-text-ot' });
      else this.binaries.set(p, c);
    }
    for (const [p, r] of Object.entries(spec.ranges ?? {})) this.doc(p).ranges = structuredClone(r);
    for (const t of spec.threads ?? []) this.threads.set(t.threadId, structuredClone(t));
  }

  settings(): ProjectSettings {
    return {
      name: this.spec.name,
      rootDoc: this.spec.rootDoc ?? (this.docs.has('main.tex') ? 'main.tex' : null),
      compiler: this.spec.compiler ?? 'pdflatex',
      texliveYear: this.spec.texliveYear ?? '2025',
      trackChangesAvailable: this.spec.trackChangesAvailable ?? true,
      permissionsLevel: 'owner',
      userId: this.userId,
    };
  }

  tree(): FileEntry[] {
    return [
      ...[...this.docs].map(([path, d]) => ({ path, kind: 'doc' as const, id: d.id })),
      ...[...this.binaries.keys()].map((path) => ({ path, kind: 'binary' as const, id: path })),
    ].sort((a, b) => a.path.localeCompare(b.path));
  }

  private doc(path: string): Doc {
    const d = this.docs.get(path);
    if (!d) throw new BackendError('not_a_doc', `${path} is not a doc`);
    return d;
  }

  async readDoc(path: string): Promise<DocState> {
    const d = this.doc(path);
    return { path, text: d.text, version: d.version, ranges: structuredClone(d.ranges), otType: d.otType };
  }

  async readBinary(path: string): Promise<Buffer> {
    const b = this.binaries.get(path);
    if (!b) throw new BackendError('not_found', `${path} not found`);
    return b;
  }

  private shiftRanges(d: Doc, splices: Splice[]) {
    for (const c of d.ranges.changes) c.pos = mapThrough(splices, c.pos, c.kind === 'delete' ? 'left' : 'right');
    for (const c of d.ranges.comments) c.pos = mapThrough(splices, c.pos, 'right');
  }

  /** Applies splices (in coordinates of `baseVersion`) like document-updater would. */
  private apply(path: string, splices: Splice[], baseVersion: number, userId: string, tracked: boolean): { at: number; applied: Splice[]; changeIds: string[]; before: string } {
    const d = this.doc(path);
    if (baseVersion > d.version || baseVersion < 0) throw new BackendError('bad_version', `version ${baseVersion} not in [0, ${d.version}]`);
    let cur = splices;
    for (let v = baseVersion; v < d.version; v++) {
      const later = d.history[v];
      cur = cur.map((s) => {
        const start = mapThrough(later, s.start, 'right');
        const end = s.end === s.start ? start : Math.max(start, mapThrough(later, s.end, 'left'));
        return { start, end, text: s.text };
      });
    }
    const changeIds: string[] = [];
    if (tracked) {
      const tc = seed();
      let n = 0;
      // Record ranges in post-edit coordinates.
      const sorted = [...cur].sort((a, b) => a.start - b.start);
      let delta = 0;
      const newChanges: Ranges['changes'] = [];
      for (const s of sorted) {
        const pos = s.start + delta;
        if (s.end > s.start) newChanges.push({ id: tc + (++n).toString(16).padStart(6, '0'), kind: 'delete', pos, text: d.text.slice(s.start, s.end), userId, ts: new Date().toISOString() });
        if (s.text) newChanges.push({ id: tc + (++n).toString(16).padStart(6, '0'), kind: 'insert', pos, text: s.text, userId, ts: new Date().toISOString() });
        delta += s.text.length - (s.end - s.start);
      }
      this.shiftRanges(d, cur);
      d.ranges.changes.push(...newChanges);
      changeIds.push(...newChanges.map((c) => c.id));
    } else this.shiftRanges(d, cur);
    const before = d.text;
    d.text = applyAll(d.text, cur);
    d.history[d.version] = cur;
    const at = d.version;
    d.version++;
    return { at, applied: cur, changeIds, before };
  }

  async applyEdit(path: string, edit: TextEdit, opts: { baseVersion: number; tracked: boolean }): Promise<EditReceipt> {
    if (this.failNextEdit) {
      const msg = this.failNextEdit;
      this.failNextEdit = null;
      throw new BackendError('send_failed', msg);
    }
    if (opts.tracked && !this.settings().trackChangesAvailable) throw new BackendError('tracking_unavailable', 'no tracked changes');
    const { at, applied, changeIds, before } = this.apply(path, edit.splices, opts.baseVersion, this.userId, opts.tracked);
    const sorted = [...applied].sort((a, b) => a.start - b.start);
    let delta = 0;
    const inserted: EditReceipt['inserted'] = [];
    const deleted: EditReceipt['deleted'] = [];
    for (const s of sorted) {
      const pos = s.start + delta;
      if (s.end > s.start) deleted.push({ pos, text: before.slice(s.start, s.end) });
      if (s.text) inserted.push({ pos, text: s.text });
      delta += s.text.length - (s.end - s.start);
    }
    this.afterApply?.(path);
    this.emit({ path, version: this.doc(path).version, userIds: [this.userId], source: 'self' });
    return { path, appliedAt: at, tracked: opts.tracked, trackedChangeIds: changeIds, inserted, deleted };
  }

  async revertEdit(path: string, receipt: EditReceipt): Promise<void> {
    const d = this.doc(path);
    // Undo by removing our inserts and restoring our deletes, located in the current text.
    const splices: Splice[] = [];
    for (const ins of receipt.inserted) {
      const at = d.text.indexOf(ins.text, Math.max(0, ins.pos - 200));
      if (at === -1) throw new BackendError('revert_failed', `inserted text not found: ${ins.text.slice(0, 40)}`);
      splices.push({ start: at, end: at + ins.text.length, text: '' });
    }
    for (const del of receipt.deleted) splices.push({ start: del.pos, end: del.pos, text: del.text });
    const ourIds = new Set(receipt.trackedChangeIds);
    this.apply(path, splices, d.version, this.userId, false);
    d.ranges.changes = d.ranges.changes.filter((c) => !ourIds.has(c.id));
    this.emit({ path, version: d.version, userIds: [this.userId], source: 'self' });
  }

  /** Test helper: a coauthor edit, in current coordinates unless `baseVersion` is given. */
  remoteEdit(path: string, splices: Splice[], userId = 'user-coauthor', baseVersion?: number, tracked = false) {
    const d = this.doc(path);
    this.apply(path, splices, baseVersion ?? d.version, userId, tracked);
    this.emit({ path, version: d.version, userIds: [userId], source: 'remote' });
  }

  private emit(c: IncomingChange) {
    for (const l of this.listeners) l(c);
  }

  onChange(listener: (change: IncomingChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  comments: CommentApi = {
    list: async () => {
      const out: CommentThread[] = [];
      for (const t of this.threads.values()) {
        let anchor = null;
        let path = t.path;
        for (const [p, d] of this.docs) {
          const c = d.ranges.comments.find((x) => x.threadId === t.threadId);
          if (c) {
            anchor = { ...c };
            path = p;
          }
        }
        out.push({ ...structuredClone(t), anchor, path });
      }
      return out;
    },
    create: async (path, pos, anchorText, body) => {
      const threadId = seed() + '000001';
      this.threads.set(threadId, {
        threadId,
        path,
        anchor: null,
        resolved: false,
        messages: [{ id: seed(), content: body, authorId: this.userId, authorName: 'Agent User', timestamp: Date.now() }],
      });
      this.doc(path).ranges.comments.push({ threadId, pos, text: anchorText });
      return { threadId };
    },
    reply: async (threadId, body) => {
      const t = this.threads.get(threadId);
      if (!t) throw new BackendError('not_found', `thread ${threadId}`);
      t.messages.push({ id: seed(), content: body, authorId: this.userId, authorName: 'Agent User', timestamp: Date.now() });
    },
    resolve: async (_path, threadId) => {
      const t = this.threads.get(threadId);
      if (!t) throw new BackendError('not_found', `thread ${threadId}`);
      t.resolved = true;
    },
    acceptChange: async (path, ids) => {
      const d = this.doc(path);
      d.ranges.changes = d.ranges.changes.filter((c) => !ids.includes(c.id));
    },
    rejectChange: async (path, ids) => {
      const d = this.doc(path);
      const changes = d.ranges.changes.filter((c) => ids.includes(c.id)).sort((a, b) => b.pos - a.pos);
      const splices: Splice[] = changes.map((c) => (c.kind === 'insert' ? { start: c.pos, end: c.pos + c.text.length, text: '' } : { start: c.pos, end: c.pos, text: c.text }));
      this.apply(path, splices, d.version, this.userId, false);
      d.ranges.changes = d.ranges.changes.filter((c) => !ids.includes(c.id));
      this.emit({ path, version: d.version, userIds: [this.userId], source: 'self' });
    },
  };

}

export class MemoryBackend implements Backend {
  projects = new Map<string, MemoryProject>();

  constructor(specs: MemoryProjectSpec[]) {
    for (const s of specs) this.projects.set(s.id, new MemoryProject(s.id, s));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return [...this.projects.values()].map((p) => ({ projectId: p.projectId, name: p.settings().name, lastUpdated: null, accessLevel: 'owner' }));
  }

  async openProject(projectId: string): Promise<ProjectHandle> {
    const p = this.projects.get(projectId);
    if (!p) throw new BackendError('not_found', `No project ${projectId}`);
    return p;
  }
}
