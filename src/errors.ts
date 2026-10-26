// Refusals carry a stable code (each has a `refusal.<code>` guide topic) plus whatever
// the agent needs to recover in `current`.

export class Refusal extends Error {
  constructor(
    public code: string,
    public detail: string,
    public current: unknown = undefined,
  ) {
    super(`${code}: ${detail}`);
  }

  toJSON() {
    return { ok: false, code: this.code, detail: this.detail, ...(this.current !== undefined ? { current: this.current } : {}) };
  }
}

export interface Warning {
  code: string;
  unit: string | null;
  detail: string;
}

export function warning(code: string, unit: string | null, detail: string): Warning {
  const d = detail.trimEnd();
  return { code, unit, detail: d.endsWith('Report this to the user.') ? d : `${d} Report this to the user.` };
}

export const REFUSAL_CODES = [
  'missing_guard',
  'guard_mismatch',
  'unit_not_found',
  'find_none',
  'find_ambiguous',
  'over_budget',
  'ref_unknown_label',
  'label_in_use',
  'label_duplicate',
  'preamble_change',
  'reflow',
  'generated_file',
  'compile_regression',
  'tracking_unavailable',
  'project_denied',
  'not_a_doc',
  'ot_type_unsupported',
  'invalid_op',
  'ops_overlap',
  'auth_expired',
  'resolve_not_requested',
  'review_not_requested',
  'bib_invalid',
  'bib_duplicate_key',
  'batch_partial_reverted',
  'resync_required',
  'send_failed',
] as const;
