// Backend over Overleaf's real-time protocol (docs/PROTOCOL.md).
//
// Local doc state is kept current by applying other clients' updates in version order.
// Our own edits are sent against the version they were prepared on and rebased by the
// server; after the ack we re-join the doc to pick up the exact merged text and ranges
// (updates arriving meanwhile are buffered and replayed).

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
  type TextEdit,
} from '../adapter.js';
import { Mutex } from '../../compile/mirror.js';
import { OverleafHttp } from './http.js';
import { Socket09 } from './socketio.js';

type ShareOp = { p: number; i?: string; d?: string; c?: string; t?: string; u?: boolean };

interface RawUpdate {
  doc: string;
  op?: ShareOp[];
  v: number;
  dup?: boolean;
  meta?: { source?: string; user_id?: string; tc?: string; ts?: number };
}

interface DocEntry {
  id: string;
  path: string;
  joined: boolean;
  text: string;
  version: number;
  ranges: Ranges;
  rangesStale: boolean;
  otType: string;
  /** Updates received while a resync or our own send is in flight. */
  buffer: RawUpdate[] | null;
  lock: Mutex;
}

interface FolderNode {
  _id: string;
  name: string;
  docs?: { _id: string; name: string }[];
  fileRefs?: { _id: string; name: string }[];
  folders?: FolderNode[];
}

interface JoinProjectResponse {
  publicId: string;
  permissionsLevel: string;
  project: {
    _id: string;
    name: string;
    rootDoc_id?: string;
    compiler?: string;
    imageName?: string;
    rootFolder: FolderNode[];
    features?: { trackChanges?: boolean; trackChangesVisible?: boolean };
    owner?: { _id: string };
  };
}

/** UTF-8 bytes carried as Latin-1 code points → string (joinDoc lines and ranges). */
export function decodeWire(s: string): string {
  return Buffer.from(s, 'latin1').toString('utf8');
}

export function idSeed(): string {
  // First 18 hex chars of an ObjectId: 8 timestamp + 10 random (RangesTracker.generateIdSeed).
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(5).toString('hex');
}

/** Applies ShareJS text ops in order. */
export function applyShareOps(text: string, ops: ShareOp[]): string {
  let t = text;
  for (const op of ops) {
    if (op.i !== undefined) t = t.slice(0, op.p) + op.i + t.slice(op.p);
    else if (op.d !== undefined) {
      if (t.slice(op.p, op.p + op.d.length) !== op.d) throw new Error(`delete component does not match at ${op.p}`);
      t = t.slice(0, op.p) + t.slice(op.p + op.d.length);
    }
  }
  return t;
}

/** Splices (base coordinates) → ShareJS components, applied right to left so positions hold. */
export function splicesToOps(base: string, edit: TextEdit): ShareOp[] {
  const ops: ShareOp[] = [];
  for (const s of [...edit.splices].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (s.end > s.start) ops.push({ p: s.start, d: base.slice(s.start, s.end) });
    if (s.text) ops.push({ p: s.start, i: s.text });
  }
  return ops;
}

function rangesFromWire(raw: unknown): Ranges {
  const r = (raw ?? {}) as {
    changes?: { id: string; op: { i?: string; d?: string; p: number }; metadata?: { user_id?: string; ts?: string } }[];
    comments?: { id: string; op: { c: string; p: number; t: string } }[];
  };
  return {
    changes: (r.changes ?? []).map((c) => ({
      id: c.id,
      kind: c.op.i !== undefined ? 'insert' : 'delete',
      pos: c.op.p,
      text: decodeWire(c.op.i ?? c.op.d ?? ''),
      userId: c.metadata?.user_id ?? null,
      ts: c.metadata?.ts ?? null,
    })),
    comments: (r.comments ?? []).map((c) => ({ threadId: c.op.t ?? c.id, pos: c.op.p, text: decodeWire(c.op.c) })),
  };
}

const parseYear = (imageName?: string) => (imageName ? (/(\d{4})/.exec(imageName)?.[1] ?? null) : null);

export class RealtimeProject implements ProjectHandle {
  private socket: Socket09 | null = null;
  private join: JoinProjectResponse | null = null;
  private docsById = new Map<string, DocEntry>();
  private folders = new Map<string, { name: string; parent: string | null }>();
  private entities = new Map<string, { name: string; folder: string; kind: 'doc' | 'binary' }>();
  private listeners = new Set<(c: IncomingChange) => void>();
  private ackWaiters = new Map<string, { resolve: (v: number) => void; reject: (e: Error) => void }>();
  private closed = false;
  private reconnecting: Promise<void> | null = null;

  constructor(
    readonly projectId: string,
    private http: OverleafHttp,
    private trace?: (dir: 'in' | 'out', raw: string) => void,
    /** Diagnostics only: send meta.tc even when the plan reports no track-changes feature. */
    private forceTracked = false,
  ) {}

  // --- connection ---------------------------------------------------------

  async connect(): Promise<void> {
    if (!this.http.csrf) await this.http.bootstrap();
    const socket = new Socket09({
      baseUrl: this.http.baseUrl,
      query: { projectId: this.projectId },
      cookie: () => this.http.jar.header(),
      onSetCookie: (sc) => this.http.jar.merge(sc),
      userAgent: this.http.userAgent,
      trace: this.trace,
    });
    const joined = new Promise<JoinProjectResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BackendError('connect_timeout', 'No joinProjectResponse within 30s')), 30000);
      socket.on('event', (name: string, args: unknown[]) => {
        if (name === 'joinProjectResponse') {
          clearTimeout(timer);
          resolve(args[0] as JoinProjectResponse);
        } else if (name === 'connectionRejected') {
          clearTimeout(timer);
          const msg = (args[0] as { message?: string })?.message ?? 'rejected';
          reject(new BackendError(/not authorized|auth/i.test(msg) ? 'auth_expired' : 'connection_rejected', `Overleaf rejected the connection: ${msg}`));
        }
      });
    });
    try {
      await socket.connect();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) throw new BackendError('auth_expired', 'Socket handshake was refused; the session cookie is probably expired.');
      throw err;
    }
    this.join = await joined;
    this.socket = socket;
    socket.on('event', (name: string, args: unknown[]) => this.onEvent(name, args));
    socket.on('close', (reason: string) => {
      if (reason !== 'client' && !this.closed) void this.reconnect();
    });
    this.indexTree();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      for (const w of this.ackWaiters.values()) w.reject(new BackendError('disconnected', 'Connection lost before the edit was acknowledged.'));
      this.ackWaiters.clear();
      let delay = 1000;
      for (let attempt = 0; attempt < 10 && !this.closed; attempt++) {
        await new Promise((r) => setTimeout(r, delay));
        try {
          await this.connect();
          for (const d of this.docsById.values()) if (d.joined) await d.lock.run(() => this.resync(d, 'resync'));
          return;
        } catch {
          delay = Math.min(delay * 2, 16000);
        }
      }
    })().finally(() => (this.reconnecting = null));
    return this.reconnecting;
  }

  private indexTree() {
    const p = this.join!.project;
    this.folders.clear();
    this.entities.clear();
    const walk = (f: FolderNode, parent: string | null, isRoot: boolean) => {
      this.folders.set(f._id, { name: isRoot ? '' : f.name, parent });
      for (const d of f.docs ?? []) this.entities.set(d._id, { name: d.name, folder: f._id, kind: 'doc' });
      for (const b of f.fileRefs ?? []) this.entities.set(b._id, { name: b.name, folder: f._id, kind: 'binary' });
      for (const sub of f.folders ?? []) walk(sub, f._id, false);
    };
    for (const root of p.rootFolder) walk(root, null, true);
    for (const [id, e] of this.entities) {
      if (e.kind !== 'doc') continue;
      const existing = this.docsById.get(id);
      if (existing) existing.path = this.pathOf(id)!;
    }
  }

  private folderPath(id: string): string {
    const parts: string[] = [];
    let cur: string | null = id;
    while (cur) {
      const f = this.folders.get(cur);
      if (!f) break;
      if (f.name) parts.unshift(f.name);
      cur = f.parent;
    }
    return parts.join('/');
  }

  private pathOf(entityId: string): string | null {
    const e = this.entities.get(entityId);
    if (!e) return null;
    const dir = this.folderPath(e.folder);
    return dir ? `${dir}/${e.name}` : e.name;
  }

  private emit(c: IncomingChange) {
    for (const l of this.listeners) l(c);
  }

  // --- events ---------------------------------------------------------------

  private onEvent(name: string, args: unknown[]) {
    switch (name) {
      case 'otUpdateApplied':
        this.onUpdate(args[0] as RawUpdate);
        break;
      case 'otUpdateError': {
        const info = args[1] as { doc_id?: string } | undefined;
        const msg = String(args[0]);
        if (info?.doc_id) this.ackWaiters.get(info.doc_id)?.reject(new BackendError('send_failed', `Overleaf rejected the update: ${msg}`));
        break;
      }
      case 'reciveNewDoc':
      case 'reciveNewFile': {
        const [folderId, ent] = args as [string, { _id: string; name: string }];
        this.entities.set(ent._id, { name: ent.name, folder: folderId, kind: name === 'reciveNewDoc' ? 'doc' : 'binary' });
        this.emit({ path: this.pathOf(ent._id)!, version: 0, userIds: [], source: 'tree' });
        break;
      }
      case 'reciveNewFolder': {
        const [parent, f] = args as [string, { _id: string; name: string }];
        this.folders.set(f._id, { name: f.name, parent });
        break;
      }
      case 'reciveEntityRename':
      case 'reciveEntityMove': {
        const [id, value] = args as [string, string];
        const before = this.pathOf(id);
        const e = this.entities.get(id);
        if (e) {
          if (name === 'reciveEntityRename') e.name = value;
          else e.folder = value;
        } else if (this.folders.has(id)) {
          const f = this.folders.get(id)!;
          if (name === 'reciveEntityRename') f.name = value;
          else f.parent = value;
        }
        this.indexTreeFromEntities();
        if (before) this.emit({ path: before, version: 0, userIds: [], source: 'tree' });
        const after = this.pathOf(id);
        if (after) this.emit({ path: after, version: 0, userIds: [], source: 'tree' });
        break;
      }
      case 'removeEntity': {
        const id = args[0] as string;
        const path = this.pathOf(id);
        this.entities.delete(id);
        this.docsById.delete(id);
        if (path) this.emit({ path, version: 0, userIds: [], source: 'tree' });
        break;
      }
      case 'forceDisconnect':
        this.socket?.close();
        if (!this.closed) void this.reconnect();
        break;
    }
  }

  private indexTreeFromEntities() {
    for (const [id, d] of this.docsById) d.path = this.pathOf(id) ?? d.path;
  }

  private onUpdate(u: RawUpdate) {
    const d = this.docsById.get(u.doc);
    if (!d || !d.joined) return;
    if (!u.op) {
      // Ack for our own update: v is the version it was applied at.
      this.ackWaiters.get(u.doc)?.resolve(u.v);
      return;
    }
    if (u.dup) return;
    if (d.buffer) {
      d.buffer.push(u);
      return;
    }
    this.applyRemote(d, u);
  }

  private applyRemote(d: DocEntry, u: RawUpdate) {
    if (u.v < d.version) return; // already in our snapshot
    const gap = () => {
      // Missed updates: buffer from here and take a fresh snapshot.
      d.buffer = [u];
      void d.lock.run(() => this.resync(d, 'resync')).catch(() => undefined);
    };
    if (u.v > d.version) return gap();
    try {
      d.text = applyShareOps(d.text, (u.op ?? []).filter((o) => o.c === undefined));
    } catch {
      return gap();
    }
    d.version++;
    d.rangesStale = true;
    this.emit({ path: d.path, version: d.version, userIds: u.meta?.user_id ? [u.meta.user_id] : [], source: 'remote' });
  }

  // --- docs -----------------------------------------------------------------------

  private entry(path: string): DocEntry {
    for (const [id, e] of this.entities) {
      if (e.kind === 'doc' && this.pathOf(id) === path) {
        let d = this.docsById.get(id);
        if (!d) {
          d = { id, path, joined: false, text: '', version: 0, ranges: { changes: [], comments: [] }, rangesStale: true, otType: 'sharejs-text-ot', buffer: null, lock: new Mutex() };
          this.docsById.set(id, d);
        }
        return d;
      }
    }
    throw new BackendError('not_a_doc', `${path} is not a doc in this project`);
  }

  /** Re-join a doc for a fresh snapshot, replaying updates that arrive meanwhile. Holds d.lock. */
  private async resync(d: DocEntry, source: IncomingChange['source'] | null): Promise<void> {
    if (!this.socket?.connected) throw new BackendError('disconnected', 'Not connected to Overleaf.');
    d.buffer ??= [];
    const beforeText = d.text;
    try {
      const res = await this.socket.request('joinDoc', [d.id, -1, { encodeRanges: true, supportsHistoryOT: true }]);
      if (res[0]) throw new BackendError('join_failed', `joinDoc ${d.path}: ${JSON.stringify(res[0])}`);
      const [, lines, version, , ranges, type] = res as [unknown, unknown, number, unknown, unknown, string | undefined];
      d.otType = type ?? 'sharejs-text-ot';
      if (d.otType === 'history-ot') {
        const raw = lines as { content?: string };
        d.text = raw.content ?? '';
        d.ranges = { changes: [], comments: [] };
      } else {
        d.text = (lines as string[]).map(decodeWire).join('\n');
        d.ranges = rangesFromWire(ranges);
      }
      d.version = version;
      d.joined = true;
      d.rangesStale = false;
    } finally {
      const buffered = d.buffer ?? [];
      d.buffer = null;
      for (const u of buffered.sort((a, b) => a.v - b.v)) this.applyRemote(d, u);
    }
    if (source && d.text !== beforeText) this.emit({ path: d.path, version: d.version, userIds: [], source });
  }

  settings(): ProjectSettings {
    const p = this.join!.project;
    const rootPath = p.rootDoc_id ? this.pathOf(p.rootDoc_id) : null;
    const compiler = (['pdflatex', 'xelatex', 'lualatex', 'latex'].includes(p.compiler ?? '') ? p.compiler : 'pdflatex') as ProjectSettings['compiler'];
    return {
      name: p.name,
      rootDoc: rootPath,
      compiler,
      texliveYear: parseYear(p.imageName),
      // CE stores tracked changes but hides the review UI (trackChangesVisible: false), so
      // coauthors could not accept or reject them there.
      trackChangesAvailable: !!p.features?.trackChanges && p.features?.trackChangesVisible !== false,
      permissionsLevel: this.join!.permissionsLevel,
      userId: this.http.userId,
    };
  }

  tree(): FileEntry[] {
    return [...this.entities.keys()]
      .map((id) => ({ path: this.pathOf(id)!, kind: this.entities.get(id)!.kind, id }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readDoc(path: string): Promise<DocState> {
    const d = this.entry(path);
    await d.lock.run(async () => {
      if (!d.joined || d.rangesStale) await this.resync(d, null);
    });
    return { path: d.path, text: d.text, version: d.version, ranges: structuredClone(d.ranges), otType: d.otType };
  }

  async readBinary(path: string): Promise<Buffer> {
    const ent = this.tree().find((e) => e.path === path && e.kind === 'binary');
    if (!ent) throw new BackendError('not_found', `${path} is not a binary file`);
    const res = await this.http.fetch(`/Project/${this.projectId}/file/${ent.id}`);
    if (!res.ok) throw new BackendError('http_error', `download ${path}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Sends one update and waits for the ack. Holds d.lock. */
  private async send(d: DocEntry, ops: ShareOp[], version: number, tc: string | null): Promise<number> {
    if (!this.socket?.connected) throw new BackendError('disconnected', 'Not connected to Overleaf.');
    if (this.ackWaiters.has(d.id)) throw new BackendError('busy', 'An update for this doc is already in flight.');
    d.buffer ??= [];
    const acked = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(d.id);
        reject(new BackendError('send_failed', 'No acknowledgement within 30s.'));
      }, 30000);
      this.ackWaiters.set(d.id, {
        resolve: (v) => {
          clearTimeout(timer);
          this.ackWaiters.delete(d.id);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.ackWaiters.delete(d.id);
          reject(e);
        },
      });
    });
    const update: Record<string, unknown> = { doc: d.id, op: ops, v: version };
    if (tc) update.meta = { tc };
    const queued = await this.socket.request('applyOtUpdate', [d.id, update]);
    if (queued[0]) {
      this.ackWaiters.get(d.id)?.reject(new BackendError('send_failed', `Overleaf refused the update: ${JSON.stringify(queued[0])}`));
    }
    try {
      return await acked;
    } finally {
      // Our update is in; rebuild exact local state (also replays buffered updates).
      await this.resync(d, null).catch(() => {
        d.buffer = null;
      });
    }
  }

  async applyEdit(path: string, edit: TextEdit, opts: { baseVersion: number; tracked: boolean }): Promise<EditReceipt> {
    const d = this.entry(path);
    if (opts.tracked && !this.settings().trackChangesAvailable && !this.forceTracked) {
      throw new BackendError('tracking_unavailable', 'Tracked changes are not available for this project.');
    }
    if (d.otType !== 'sharejs-text-ot') throw new BackendError('ot_type_unsupported', `${path} is ${d.otType}`);
    const ops = splicesToOps(edit.baseText, edit);
    if (!ops.length) throw new BackendError('send_failed', 'Empty edit.');
    const tc = opts.tracked ? idSeed() : null;
    const appliedAt = await d.lock.run(() => this.send(d, ops, opts.baseVersion, tc));
    // Positions after the edit, in the coordinates of the edit's own base (best effort).
    const inserted: EditReceipt['inserted'] = [];
    const deleted: EditReceipt['deleted'] = [];
    let delta = 0;
    for (const s of [...edit.splices].sort((a, b) => a.start - b.start)) {
      const pos = s.start + delta;
      if (s.end > s.start) deleted.push({ pos, text: edit.baseText.slice(s.start, s.end) });
      if (s.text) inserted.push({ pos, text: s.text });
      delta += s.text.length - (s.end - s.start);
    }
    const trackedChangeIds = tc ? d.ranges.changes.filter((c) => c.id.startsWith(tc)).map((c) => c.id) : [];
    this.emit({ path: d.path, version: d.version, userIds: this.http.userId ? [this.http.userId] : [], source: 'self' });
    return { path: d.path, appliedAt, tracked: opts.tracked, trackedChangeIds, inserted, deleted };
  }

  async revertEdit(path: string, receipt: EditReceipt): Promise<void> {
    const d = this.entry(path);
    await d.lock.run(async () => {
      await this.resync(d, null);
      const ops: ShareOp[] = [];
      // Right to left so earlier positions stay valid.
      const items = [
        ...receipt.inserted.map((x) => ({ kind: 'ins' as const, ...x })),
        ...receipt.deleted.map((x) => ({ kind: 'del' as const, ...x })),
      ].sort((a, b) => b.pos - a.pos || (a.kind === 'ins' ? -1 : 1));
      let text = d.text;
      for (const it of items) {
        if (it.kind === 'ins') {
          const at = locate(text, it.text, it.pos);
          if (at === -1) throw new BackendError('revert_failed', `Could not find inserted text to revert in ${path}.`);
          ops.push({ p: at, d: it.text });
          text = text.slice(0, at) + text.slice(at + it.text.length);
        } else {
          const op: ShareOp = { p: Math.min(it.pos, text.length), i: it.text };
          if (receipt.tracked) op.u = true; // undo: drops our tracked delete instead of adding text
          ops.push(op);
          text = text.slice(0, op.p) + it.text + text.slice(op.p);
        }
      }
      if (ops.length) await this.send(d, ops, d.version, null);
    });
    this.emit({ path: d.path, version: d.version, userIds: [], source: 'self' });
  }

  onChange(listener: (change: IncomingChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    this.socket?.close();
  }

  // --- comments and review -------------------------------------------------------------

  comments: CommentApi = {
    list: async () => {
      type Thread = { messages: { id: string; content: string; timestamp: number; user_id: string; user?: { first_name?: string; last_name?: string; email?: string } }[]; resolved?: boolean };
      const threads = await this.http.json<Record<string, Thread>>(`/project/${this.projectId}/threads`);
      const anchors = new Map<string, { path: string; c: Ranges['comments'][number] }>();
      for (const e of this.tree()) {
        if (e.kind !== 'doc') continue;
        const st = await this.readDoc(e.path);
        for (const c of st.ranges.comments) anchors.set(c.threadId, { path: e.path, c });
      }
      const out: CommentThread[] = [];
      for (const [threadId, t] of Object.entries(threads)) {
        const a = anchors.get(threadId);
        out.push({
          threadId,
          path: a?.path ?? null,
          anchor: a?.c ?? null,
          resolved: !!t.resolved,
          messages: (t.messages ?? []).map((m) => ({
            id: m.id,
            content: m.content,
            authorId: m.user_id ?? null,
            authorName: [m.user?.first_name, m.user?.last_name].filter(Boolean).join(' ') || m.user?.email || 'unknown',
            timestamp: m.timestamp ?? null,
          })),
        });
      }
      return out;
    },
    create: async (path, pos, anchorText, body) => {
      const threadId = idSeed() + '000001';
      await this.http.post(`/project/${this.projectId}/thread/${threadId}/messages`, { content: body });
      const d = this.entry(path);
      await d.lock.run(async () => {
        if (!d.joined) await this.resync(d, null);
        if (d.text.slice(pos, pos + anchorText.length) !== anchorText) throw new BackendError('send_failed', 'Anchor text moved; re-read and retry.');
        await this.send(d, [{ c: anchorText, p: pos, t: threadId }], d.version, null);
      });
      return { threadId };
    },
    reply: async (threadId, body) => {
      await this.http.post(`/project/${this.projectId}/thread/${threadId}/messages`, { content: body });
    },
    resolve: async (path, threadId) => {
      const d = this.entry(path);
      await this.http.post(`/project/${this.projectId}/doc/${d.id}/thread/${threadId}/resolve`, {});
    },
    acceptChange: async (path, changeIds) => {
      const d = this.entry(path);
      await this.http.post(`/project/${this.projectId}/doc/${d.id}/changes/accept`, { change_ids: changeIds });
      await d.lock.run(() => this.resync(d, null));
    },
    rejectChange: async (path, changeIds) => {
      const d = this.entry(path);
      await d.lock.run(async () => {
        await this.resync(d, null);
        const changes = d.ranges.changes.filter((c) => changeIds.includes(c.id)).sort((a, b) => b.pos - a.pos);
        const ops: ShareOp[] = changes.map((c) => (c.kind === 'insert' ? { p: c.pos, d: c.text } : { p: c.pos, i: c.text, u: true }));
        if (ops.length) await this.send(d, ops, d.version, null);
      });
      this.emit({ path: d.path, version: d.version, userIds: [], source: 'self' });
    },
  };
}

/** Finds `needle` nearest to `near`. */
function locate(text: string, needle: string, near: number): number {
  if (text.slice(near, near + needle.length) === needle) return near;
  let best = -1;
  let i = text.indexOf(needle);
  while (i !== -1) {
    if (best === -1 || Math.abs(i - near) < Math.abs(best - near)) best = i;
    i = text.indexOf(needle, i + 1);
  }
  return best;
}

export class RealtimeBackend implements Backend {
  private http: OverleafHttp;

  constructor(
    baseUrl: string,
    cookie: string,
    private trace?: (dir: 'in' | 'out', raw: string) => void,
    private forceTracked = false,
  ) {
    this.http = new OverleafHttp(baseUrl.replace(/\/$/, ''), cookie);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    try {
      type P = { id: string; name: string; lastUpdated?: string; accessLevel?: string; archived?: boolean; trashed?: boolean };
      const r = await this.http.post<{ projects: P[] }>('/api/project', { page: { size: 1000 }, sort: { by: 'lastUpdated', order: 'desc' } });
      return r.projects.filter((p) => !p.archived && !p.trashed).map((p) => ({ projectId: p.id, name: p.name, lastUpdated: p.lastUpdated ?? null, accessLevel: p.accessLevel ?? 'unknown' }));
    } catch (err) {
      if (err instanceof BackendError && err.code === 'auth_expired') throw err;
      const r = await this.http.json<{ projects: { _id: string; name: string; accessLevel: string }[] }>('/user/projects');
      return r.projects.map((p) => ({ projectId: p._id, name: p.name, lastUpdated: null, accessLevel: p.accessLevel }));
    }
  }

  async openProject(projectId: string): Promise<ProjectHandle> {
    if (!/^[0-9a-f]{24}$/.test(projectId)) throw new BackendError('not_found', `"${projectId}" is not an Overleaf project ID.`);
    const p = new RealtimeProject(projectId, this.http, this.trace, this.forceTracked);
    await p.connect();
    return p;
  }
}
