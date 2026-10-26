# Implementation decisions and deviations

Decisions made while implementing the spec, where the spec left room or where reality
differed. Fixed decisions D1–D6 are unchanged.

## Phase 0 findings (from source; verified live on CE and overleaf.com)

- **Tracked changes are per update** (`meta.tc`, 18 hex chars). real-time checks only
  permissions; document-updater tracks iff `meta.tc` is set. D2 is feasible. See PROTOCOL.md §7.
- Overleaf still speaks **Socket.IO 0.9**; we implement the framing (`src/adapters/realtime/socketio.ts`).
- **history-ot docs** (projects migrated to Overleaf's newer OT) are read-only here:
  writes refuse `ot_type_unsupported`. Document-updater itself still has TODOs for tracked
  changes on history-ot.
- **Community Edition** stores tracked changes (verified: `meta.tc` produced a change with the
  predicted id) but hides the review UI (`features.trackChangesVisible: false`), and does not
  route the thread/accept endpoints (verified: 404). With D2, CE projects refuse
  `tracking_unavailable` unless the user agrees to `tracked: false`. Comment tools fail on CE.

## Parser

`@unified-latex/unified-latex-util-parse` was evaluated first. It parses all fixtures
without throwing, but on fixture 3 (an unclosed `figure`) it silently drops the figure from
the environment structure instead of failing. We can't detect that, and the spec forbids
guessed structure, so `src/model/outline.ts` is a tolerant line-oriented parser for the §7
subset that falls back to line blocks whenever an environment or heading doesn't close.

## Interface changes

- `applyEdit` returns an `EditReceipt` (superset of `{version}`) with the tracked change ids
  and what was inserted/deleted, so `revertEdit` can undo it.
- `TextEdit` carries `baseText`: deletes must quote the text they remove at `baseVersion`, and
  the adapter only holds the current text.
- Checks live in `src/checks/latexchecks.ts` (refs, labels, cites, preamble) plus
  `bibtex.ts` and `generated.ts`, instead of one file per check.

## Semantics the spec left open

- **Ops resolve against the text the agent read.** All targets in one `update` resolve on the
  same snapshot; splices are applied together. Overlapping ops refuse `ops_overlap`.
- **`ifVersion` freshness.** The session records which unit IDs changed at each doc version.
  If any target unit changed after `ifVersion`, refuse `guard_mismatch`. If the log can't
  answer (version older than when the session opened), refuse conservatively.
- **Unit-level insert** adds the content as its own blank-line-separated block. `find`-level
  insert is raw.
- **Path IDs with a stale hash and no hash match** refuse `unit_not_found` (§7.3) and include
  the unit now at that path; stale label IDs refuse `guard_mismatch`.
- **Diff budget** measures the unit's own span (sections: the heading only), whitespace
  normalized, Levenshtein over characters. Moves are exempt (text is relocated, not changed).
- **Reflow** is flagged only when the line break moves between two words whose lines have no
  other word changes, so rewrapping a line you edited is allowed.
- **Outline `<gap>`** collapses runs of ≥8 plain paragraphs (no label, comment, tracked change)
  in files with ≥60 units, keeping the first and last of each run.
- **Tracked-change ids** come from the ranges after the edit, matched by our `tc` prefix.
  An insert that merges into an adjacent tracked insert by the same user keeps the old id and
  is not listed.
- **Comment anchors** must be 3–6 words (spec), else `invalid_op`.

## Additional codes

Refusals not in §12: `unit_not_found`, `invalid_op`, `ops_overlap`, `not_a_doc`,
`ot_type_unsupported`, `send_failed`, `review_not_requested`, `resync_required`,
`auth_expired`. Warnings not in §12: `compile_skipped` (no Docker, no root doc, or compile
disabled) and `compile_timeout`. The compile gate never blocks an edit when it cannot run;
the agent is told to report that the edit was not compile-checked.

## Concurrency model

The adapter applies other clients' updates in version order. Our edit is sent against the
version it was prepared on and rebased by Overleaf's server-side OT. While it is in flight,
incoming updates are buffered; after the ack the doc is re-joined for an exact snapshot and
the buffer is replayed. A version gap or a failed apply triggers the same re-join.

The mirror is written only under its lock, so a coauthor edit can't land in the mirror
mid-compile.

## Open items for the owner

- **Terms of service.** Not reviewed. Overleaf's terms should be checked for automated clients
  that act through a user's session cookie before wider use.
- **Live verification.** Done against CE (`test/ce.test.ts`) and the Phase 0 spike on
  overleaf.com. Still needed on overleaf.com: PROTOCOL.md items marked VERIFY (free-plan
  tracking, resolve, accept) and the Phase 2/3 acceptance list.
- **Phase 4** (Git adapter) is not implemented; `"backend": "git"` exits with a message.
