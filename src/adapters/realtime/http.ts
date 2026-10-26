// HTTP side of the Overleaf web service: cookie jar, CSRF token, JSON helpers.

import { BackendError } from '../adapter.js';

const UA = 'overleaf-mcp/0.1';

export class CookieJar {
  private map = new Map<string, string>();

  constructor(initial: string) {
    const raw = initial.trim();
    // A bare session value: decide the cookie name later from the host.
    if (!raw.includes('=') || /^s(%3A|:)/.test(raw)) this.bare = raw;
    else this.parse(raw);
  }

  bare: string | null = null;

  /** Resolves a bare cookie value to the right cookie name for the server. */
  applyDefaultName(baseUrl: string) {
    if (!this.bare) return;
    this.map.set(/overleaf\.com$/.test(new URL(baseUrl).hostname) ? 'overleaf_session2' : 'overleaf.sid', this.bare);
    this.bare = null;
  }

  private parse(s: string) {
    for (const part of s.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) this.map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }

  merge(setCookies: string[]) {
    for (const sc of setCookies) {
      const nv = sc.split(';')[0];
      const eq = nv.indexOf('=');
      if (eq > 0) this.map.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(name: string) {
    return this.map.has(name);
  }
}

export class OverleafHttp {
  readonly jar: CookieJar;
  csrf: string | null = null;
  userId: string | null = null;

  constructor(
    readonly baseUrl: string,
    cookie: string,
  ) {
    this.jar = new CookieJar(cookie);
    this.jar.applyDefaultName(baseUrl);
  }

  get userAgent() {
    return UA;
  }

  async fetch(path: string, init: RequestInit & { csrf?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Cookie', this.jar.header());
    headers.set('User-Agent', UA);
    if (init.csrf) {
      if (!this.csrf) await this.bootstrap();
      headers.set('X-Csrf-Token', this.csrf!);
    }
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers, redirect: 'manual' });
    this.jar.merge(res.headers.getSetCookie?.() ?? []);
    if (res.status === 401 || (res.status >= 300 && res.status < 400 && /\/login/.test(res.headers.get('location') ?? ''))) {
      throw new BackendError('auth_expired', 'The Overleaf session cookie is missing or expired.');
    }
    return res;
  }

  /** Validates the session and reads the CSRF token and user ID from the project page. */
  async bootstrap(): Promise<void> {
    const res = await this.fetch('/project');
    if (!res.ok) throw new BackendError(res.status === 403 ? 'auth_expired' : 'http_error', `GET /project returned HTTP ${res.status}`);
    const html = await res.text();
    const meta = (name: string) => new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`).exec(html)?.[1] ?? null;
    this.csrf = meta('ol-csrfToken');
    this.userId = meta('ol-user_id');
    if (!this.csrf) throw new BackendError('auth_expired', 'Could not read a CSRF token; the session cookie is probably invalid.');
    if (/overleaf\.com$/.test(new URL(this.baseUrl).hostname) && !this.jar.has('GCLB')) {
      // Load-balancer affinity cookie, needed so the WebSocket lands on the same backend.
      const r = await this.fetch('/socket.io/socket.io.js').catch(() => null);
      await r?.body?.cancel();
    }
  }

  async json<T>(path: string, init: RequestInit & { csrf?: boolean } = {}): Promise<T> {
    const res = await this.fetch(path, { ...init, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
    if (!res.ok) throw new BackendError(res.status === 403 ? 'forbidden' : 'http_error', `${init.method ?? 'GET'} ${path} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), csrf: true });
  }
}
