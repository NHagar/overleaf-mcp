// JSONL audit log (spec §15). Never holds credentials, and at most 200 characters of
// document text per op.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditRecord {
  tool: string;
  projectId?: string;
  file?: string;
  ops?: unknown[];
  receipts?: unknown[];
  warnings?: unknown[];
  refusal?: string | null;
  [k: string]: unknown;
}

const MAX_CONTEXT = 200;

export function clip(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  return s.length > MAX_CONTEXT ? `${s.slice(0, MAX_CONTEXT)}…(${s.length} chars)` : s;
}

/** Op summary for the log: op kind, target, and clipped text fields. */
export function summarizeOp(op: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op)) {
    if (k === 'target' || k === 'to') {
      const t = v as Record<string, unknown>;
      out[k] = Object.fromEntries(Object.entries(t).map(([kk, vv]) => [kk, clip(vv)]));
    } else out[k] = clip(v);
  }
  return out;
}

export class AuditLog {
  constructor(private path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  write(rec: AuditRecord): void {
    if (!this.path) return;
    try {
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', { mode: 0o600 });
    } catch {
      // Auditing must never break a tool call.
    }
  }
}
