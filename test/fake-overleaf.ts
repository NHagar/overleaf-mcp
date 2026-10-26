// A tiny stand-in for Overleaf's web + real-time services, speaking Socket.IO 0.9 frames,
// for exercising the real-time adapter without a live server. It implements only what the
// adapter uses, with the behaviours described in docs/PROTOCOL.md.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodePacket, encodePacket, PacketType } from '../src/adapters/realtime/socketio.js';

type Op = { p: number; i?: string; d?: string; c?: string; t?: string; u?: boolean };

interface FakeDoc {
  id: string;
  name: string;
  text: string;
  version: number;
  history: Op[][];
  changes: { id: string; op: { i?: string; d?: string; p: number }; metadata: { user_id: string } }[];
  comments: { id: string; op: { c: string; p: number; t: string } }[];
}

const encode = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

function shift(p: number, op: Op, after = false): number {
  if (op.i !== undefined) return p > op.p || (p === op.p && after) ? p + op.i.length : p;
  if (op.d !== undefined) return p <= op.p ? p : p >= op.p + op.d.length ? p - op.d.length : op.p;
  return p;
}

export class FakeOverleaf {
  server!: Server;
  wss!: WebSocketServer;
  url = '';
  cookie = 'overleaf.sid=good';
  projectId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  userId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  docs = new Map<string, FakeDoc>();
  received: { name: string; args: unknown[] }[] = [];
  threads: Record<string, { messages: unknown[]; resolved?: boolean }> = {};
  clients = new Set<WebSocket>();
  /** Runs before an incoming client update is applied (to simulate a concurrent edit). */
  beforeApply: ((doc: FakeDoc) => void) | null = null;
  trackChanges = true;

  addDoc(id: string, name: string, text: string) {
    this.docs.set(id, { id, name, text, version: 5, history: [], changes: [], comments: [] });
  }

  async start() {
    this.server = createServer((req, res) => void this.http(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, sock, head) => {
      if (!(req.headers.cookie ?? '').includes(this.cookie)) return sock.destroy();
      this.wss.handleUpgrade(req, sock, head, (ws) => this.onSocket(ws));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    for (const c of this.clients) c.terminate();
    this.wss.close();
    await new Promise((r) => this.server.close(r));
  }

  private async http(req: IncomingMessage, res: ServerResponse) {
    const authed = (req.headers.cookie ?? '').includes(this.cookie);
    const url = new URL(req.url!, this.url);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (!authed) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (url.pathname === '/project') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<meta name="ol-csrfToken" content="csrf123"><meta name="ol-user_id" content="${this.userId}">`);
    }
    if (url.pathname === '/socket.io/1/') return res.end('sid123:60:60:websocket');
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== 'csrf123') return json(403, { error: 'csrf' });
    if (url.pathname === '/api/project') return json(200, { projects: [{ id: this.projectId, name: 'Paper', lastUpdated: '2026-10-01', accessLevel: 'owner' }] });
    let m = /^\/project\/\w+\/thread\/(\w+)\/messages$/.exec(url.pathname);
    if (m) {
      const t = (this.threads[m[1]] ??= { messages: [] });
      t.messages.push({ id: `m${t.messages.length}`, content: JSON.parse(body).content, timestamp: 1, user_id: this.userId, user: { first_name: 'Agent', last_name: 'User' } });
      return json(200, {});
    }
    if (/^\/project\/\w+\/threads$/.test(url.pathname)) return json(200, this.threads);
    m = /^\/Project\/\w+\/file\/(\w+)$/.exec(url.pathname);
    if (m) {
      res.writeHead(200);
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    json(404, {});
  }

  private send(ws: WebSocket, name: string, args: unknown[]) {
    ws.send(encodePacket({ type: PacketType.event, data: { name, args } }));
  }

  broadcast(name: string, args: unknown[], except?: WebSocket) {
    for (const c of this.clients) if (c !== except) this.send(c, name, args);
  }

  private onSocket(ws: WebSocket) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.send('1::');
    const docs = [...this.docs.values()];
    this.send(ws, 'joinProjectResponse', [
      {
        publicId: 'P.1',
        permissionsLevel: 'owner',
        protocolVersion: 2,
        project: {
          _id: this.projectId,
          name: 'Paper',
          rootDoc_id: docs[0]?.id,
          compiler: 'xelatex',
          imageName: 'texlive-full:2024.1',
          features: { trackChanges: this.trackChanges },
          rootFolder: [
            {
              _id: 'f0',
              name: 'rootFolder',
              docs: docs.filter((d) => !d.name.includes('/')).map((d) => ({ _id: d.id, name: d.name })),
              fileRefs: [{ _id: 'img1', name: 'fig.png' }],
              folders: [{ _id: 'f1', name: 'sections', docs: docs.filter((d) => d.name.includes('/')).map((d) => ({ _id: d.id, name: d.name.split('/')[1] })), fileRefs: [], folders: [] }],
            },
          ],
        },
      },
    ]);
    ws.on('message', (data) => {
      const p = decodePacket(data.toString());
      if (p.type !== PacketType.event) return;
      const { name, args } = p.data as { name: string; args: unknown[] };
      this.received.push({ name, args });
      const ack = (v: unknown[]) => ws.send(encodePacket({ type: PacketType.ack, id: p.id, data: v }));
      if (name === 'joinDoc') {
        const d = this.docs.get(args[0] as string)!;
        ack([
          null,
          d.text.split('\n').map(encode),
          d.version,
          [],
          { changes: d.changes.map((c) => ({ ...c, op: { ...c.op, ...(c.op.i ? { i: encode(c.op.i) } : {}) } })), comments: d.comments },
          'sharejs-text-ot',
        ]);
      } else if (name === 'applyOtUpdate') {
        const [docId, update] = args as [string, { op: Op[]; v: number; meta?: { tc?: string } }];
        const d = this.docs.get(docId)!;
        this.beforeApply?.(d);
        this.beforeApply = null;
        // Server-side rebase onto ops the client hasn't seen.
        let ops = update.op;
        for (let v = update.v; v < d.version; v++) {
          const later = d.history[v] ?? [];
          ops = ops.map((o) => later.reduce((acc, l) => ({ ...acc, p: shift(acc.p, l) }), o));
        }
        try {
          this.apply(d, ops, update.meta?.tc);
        } catch (e) {
          ack([]);
          this.send(ws, 'otUpdateError', [String(e), { doc_id: docId }]);
          return;
        }
        ack([]);
        this.send(ws, 'otUpdateApplied', [{ v: d.version - 1, doc: docId }]);
        this.broadcast('otUpdateApplied', [{ doc: docId, op: ops, v: d.version - 1, meta: { user_id: this.userId, source: 'P.1', tc: update.meta?.tc } }], ws);
      }
    });
  }

  private apply(d: FakeDoc, ops: Op[], tc?: string) {
    let n = 0;
    for (const o of ops) {
      if (o.c !== undefined) {
        d.comments.push({ id: o.t!, op: { c: o.c, p: o.p, t: o.t! } });
        continue;
      }
      if (o.i !== undefined) {
        d.text = d.text.slice(0, o.p) + o.i + d.text.slice(o.p);
        if (tc) d.changes.push({ id: tc + (++n).toString(16).padStart(6, '0'), op: { i: o.i, p: o.p }, metadata: { user_id: this.userId } });
      } else if (o.d !== undefined) {
        if (d.text.slice(o.p, o.p + o.d.length) !== o.d) throw new Error('Delete component does not match');
        d.text = d.text.slice(0, o.p) + d.text.slice(o.p + o.d.length);
      }
    }
    d.history[d.version] = ops;
    d.version++;
  }

  /** A coauthor's edit, broadcast to every client. */
  remoteEdit(docId: string, ops: Op[], opts: { silent?: boolean } = {}) {
    const d = this.docs.get(docId)!;
    this.apply(d, ops);
    if (!opts.silent) this.broadcast('otUpdateApplied', [{ doc: docId, op: ops, v: d.version - 1, meta: { user_id: 'cccccccccccccccccccccccc', source: 'P.2' } }]);
  }
}
