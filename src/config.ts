import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

export function expandHome(p: string): string {
  return p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^\//, '')) : resolve(p);
}

/** TeX Live year → image. Overleaf's "TeX Live 2025" etc. map to the historic full images. */
const DEFAULT_IMAGES: Record<string, string> = { '2020': 'texlive/texlive:TL2020-historic', '2021': 'texlive/texlive:TL2021-historic', '2022': 'texlive/texlive:TL2022-historic', '2023': 'texlive/texlive:TL2023-historic', '2024': 'texlive/texlive:TL2024-historic', '2025': 'texlive/texlive:TL2025-historic' };

const ConfigSchema = z.object({
  backend: z.enum(['realtime', 'git']).default('realtime'),
  baseUrl: z.string().url().default('https://www.overleaf.com'),
  auth: z
    .object({
      cookieFile: z.string().default('~/.overleaf-mcp/cookie'),
    })
    .default({ cookieFile: '~/.overleaf-mcp/cookie' }),
  denylist: z.array(z.string()).default([]),
  diffBudget: z.object({ threshold: z.number().min(0).max(1).default(0.25) }).default({ threshold: 0.25 }),
  compile: z
    .object({
      enabled: z.boolean().default(true),
      images: z.record(z.string(), z.string()).default(DEFAULT_IMAGES),
      defaultImage: z.string().default('texlive/texlive:latest'),
      timeoutSeconds: z.number().positive().default(120),
      mirrorDir: z.string().default('~/.overleaf-mcp/mirrors'),
      dockerBinary: z.string().default('docker'),
    })
    .default({
      enabled: true,
      images: DEFAULT_IMAGES,
      defaultImage: 'texlive/texlive:latest',
      timeoutSeconds: 120,
      mirrorDir: '~/.overleaf-mcp/mirrors',
      dockerBinary: 'docker',
    }),
  auditLog: z.string().default('~/.overleaf-mcp/audit.jsonl'),
  changeLogSize: z.number().int().positive().default(2000),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Strips // and /* *\/ comments outside strings so the config file can be JSONC. */
export function stripJsonComments(src: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += src[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw ?? {});
}

export function loadConfig(path = process.env.OVERLEAF_MCP_CONFIG ?? '~/.overleaf-mcp/config.jsonc'): Config {
  const full = expandHome(path);
  let raw: unknown = {};
  if (existsSync(full)) raw = JSON.parse(stripJsonComments(readFileSync(full, 'utf8')));
  const cfg = parseConfig(raw);
  if (process.env.OVERLEAF_BASE_URL) cfg.baseUrl = process.env.OVERLEAF_BASE_URL;
  return cfg;
}

export class CredentialError extends Error {}

/**
 * Reads the session cookie from OVERLEAF_COOKIE or the cookie file. The file must not be
 * readable by group or others (mode 0600), since it grants full access to the account.
 */
export function loadCookie(cfg: Config): string {
  if (process.env.OVERLEAF_COOKIE) return process.env.OVERLEAF_COOKIE.trim();
  const file = expandHome(cfg.auth.cookieFile);
  if (!existsSync(file)) {
    throw new CredentialError(
      `No session cookie. Set OVERLEAF_COOKIE or write the cookie to ${file} (chmod 600).`,
    );
  }
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new CredentialError(`Cookie file ${file} has mode ${mode.toString(8)}; run chmod 600 on it.`);
  }
  return readFileSync(file, 'utf8').trim();
}
