// Minimal Socket.IO 0.9 (protocol v1) client over WebSocket. Overleaf's real-time
// service still speaks this protocol; modern socket.io-client cannot connect to it.
// Frames are "type:id[+]:endpoint[:data]" (see docs/PROTOCOL.md §0).

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const PacketType = { disconnect: 0, connect: 1, heartbeat: 2, message: 3, json: 4, event: 5, ack: 6, error: 7, noop: 8 } as const;

export interface Packet {
  type: number;
  id?: string;
  ack?: boolean;
  endpoint?: string;
  data?: unknown;
}

export function encodePacket(p: Packet): string {
  if (p.type === PacketType.disconnect || p.type === PacketType.noop) return String(p.type);
  if (p.type === PacketType.ack) return `6:::${p.id}+${p.data === undefined ? '' : JSON.stringify(p.data)}`;
  const id = p.id ? `${p.id}${p.ack ? '+' : ''}` : '';
  const head = `${p.type}:${id}:${p.endpoint ?? ''}`;
  if (p.type === PacketType.connect || p.type === PacketType.heartbeat) return head;
  const data = p.type === PacketType.json || p.type === PacketType.event ? JSON.stringify(p.data) : String(p.data ?? '');
  return `${head}:${data}`;
}

export function decodePacket(raw: string): Packet {
  const type = Number(raw[0]);
  if (!(type >= 0 && type <= 8)) throw new Error(`bad packet type in ${raw.slice(0, 20)}`);
  if (raw.length === 1) return { type };
  const c1 = raw.indexOf(':', 1);
  const c2 = raw.indexOf(':', c1 + 1);
  if (c1 === -1 || c2 === -1) return { type };
  const idField = raw.slice(c1 + 1, c2);
  const p: Packet = { type };
  if (idField) {
    p.ack = idField.endsWith('+');
    p.id = p.ack ? idField.slice(0, -1) : idField;
  }
  const c3 = raw.indexOf(':', c2 + 1);
  p.endpoint = c3 === -1 ? raw.slice(c2 + 1) : raw.slice(c2 + 1, c3);
  const data = c3 === -1 ? '' : raw.slice(c3 + 1);
  if (type === PacketType.event || type === PacketType.json) p.data = data ? JSON.parse(data) : undefined;
  else if (type === PacketType.ack) {
    const plus = data.indexOf('+');
    p.id = plus === -1 ? data : data.slice(0, plus);
    p.data = plus === -1 || plus === data.length - 1 ? [] : JSON.parse(data.slice(plus + 1));
  } else if (data) p.data = data;
  return p;
}

export interface SocketOptions {
  baseUrl: string;
  query: Record<string, string>;
  cookie: () => string;
  onSetCookie?: (setCookies: string[]) => void;
  userAgent?: string;
  /** Debug hook: every raw frame in and out. */
  trace?: (dir: 'in' | 'out', raw: string) => void;
}

/**
 * Events: 'connect', 'event' (name, args), 'close' (reason), 'error' (err).
 * The socket does not reconnect by itself; the project layer owns reconnect policy.
 */
export class Socket09 extends EventEmitter {
  private ws: WebSocket | null = null;
  private ackSeq = 0;
  private acks = new Map<string, (args: unknown[]) => void>();
  private heartbeat: NodeJS.Timeout | null = null;
  private closedByUs = false;
  connected = false;

  constructor(private o: SocketOptions) {
    super();
  }

  private qs(): string {
    return new URLSearchParams({ ...this.o.query, t: String(Date.now()) }).toString();
  }

  private headers(): Record<string, string> {
    return { Cookie: this.o.cookie(), Origin: this.o.baseUrl, ...(this.o.userAgent ? { 'User-Agent': this.o.userAgent } : {}) };
  }

  async connect(timeoutMs = 30000): Promise<void> {
    this.closedByUs = false;
    const res = await fetch(`${this.o.baseUrl}/socket.io/1/?${this.qs()}`, { headers: this.headers(), redirect: 'manual' });
    this.o.onSetCookie?.(res.headers.getSetCookie?.() ?? []);
    const body = await res.text();
    if (!res.ok) throw Object.assign(new Error(`handshake failed: HTTP ${res.status} ${body.slice(0, 200)}`), { status: res.status });
    const [sid, hb] = body.split(':');
    if (!sid) throw new Error(`bad handshake response: ${body.slice(0, 100)}`);
    const heartbeatSec = Number(hb) || 60;
    const wsUrl = `${this.o.baseUrl.replace(/^http/, 'ws')}/socket.io/1/websocket/${sid}?${this.qs()}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: this.headers() });
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error('socket connect timeout'));
        ws.terminate();
      }, timeoutMs);
      let settled = false;
      ws.on('message', (data) => {
        const raw = data.toString();
        this.o.trace?.('in', raw);
        let p: Packet;
        try {
          p = decodePacket(raw);
        } catch (err) {
          this.emit('error', err);
          return;
        }
        if (p.type === PacketType.connect && !settled) {
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          this.heartbeat = setInterval(() => this.send({ type: PacketType.heartbeat }), heartbeatSec * 800);
          resolve();
          this.emit('connect');
          return;
        }
        this.onPacket(p);
      });
      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        } else this.emit('error', err);
      });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.teardown();
        if (!settled) {
          settled = true;
          reject(new Error(`socket closed during connect (${code} ${reason.toString()})`));
        }
        this.emit('close', this.closedByUs ? 'client' : `server (${code} ${reason.toString()})`);
      });
    });
  }

  private onPacket(p: Packet) {
    switch (p.type) {
      case PacketType.heartbeat:
        this.send({ type: PacketType.heartbeat });
        break;
      case PacketType.event: {
        const d = p.data as { name: string; args?: unknown[] };
        this.emit('event', d.name, d.args ?? []);
        break;
      }
      case PacketType.ack: {
        const cb = p.id ? this.acks.get(p.id) : undefined;
        if (cb) {
          this.acks.delete(p.id!);
          cb(Array.isArray(p.data) ? p.data : [p.data]);
        }
        break;
      }
      case PacketType.error:
        this.emit('error', new Error(`socket.io error: ${String(p.data ?? '')}`));
        break;
      case PacketType.disconnect:
        this.ws?.close();
        break;
    }
  }

  private send(p: Packet) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const raw = encodePacket(p);
    this.o.trace?.('out', raw);
    this.ws.send(raw);
  }

  emitEvent(name: string, args: unknown[]): void {
    this.send({ type: PacketType.event, data: { name, args } });
  }

  /** Emits with an ack callback. Resolves with the ack args; the first is the error slot. */
  request(name: string, args: unknown[], timeoutMs = 30000): Promise<unknown[]> {
    if (!this.connected) return Promise.reject(new Error('not connected'));
    const id = String(++this.ackSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new Error(`${name} timed out`));
      }, timeoutMs);
      this.acks.set(id, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
      this.send({ type: PacketType.event, id, ack: true, data: { name, args } });
    });
  }

  private teardown() {
    this.connected = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const cb of this.acks.values()) cb(['disconnected']);
    this.acks.clear();
    this.ws = null;
  }

  close() {
    this.closedByUs = true;
    if (this.ws) {
      this.send({ type: PacketType.disconnect });
      this.ws.close();
    }
  }
}
