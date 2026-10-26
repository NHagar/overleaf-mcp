# Overleaf real-time protocol notes (Phase 0)

Status: **derived from source; verified live against Overleaf Community Edition
(`sharelatex/sharelatex:latest`) and overleaf.com, 2026-10-26.**

Sources read (shallow clone of `github.com/overleaf/overleaf` main, October 2026):

- `services/real-time/app/js/{Router,WebsocketController,DocumentUpdaterController}.js`
- `services/document-updater/app/js/{UpdateManager,RangesManager,DocumentManager}.js`
- `libraries/ranges-tracker/index.cjs`
- `services/web/app/src/router.mjs`, `Features/Project/{ProjectController,ProjectListController,ProjectEditorHandler}.mjs`
- `services/web/frontend/js/features/ide-react/editor/{share-js-doc,document-container}.ts`
- `services/web/frontend/js/features/review-panel/context/{threads-context,ranges-context}.tsx`
- `services/web/frontend/js/features/source-editor/extensions/changes/reject-changes.ts`
- Reference client `github.com/mei28/nvim-overleaf` (`denops/overleaf/protocol/*`, `auth/*`, `document/document.ts`)

Examples marked **(live)** were captured with `scripts/phase0-spike.ts`, which records
traffic to `spike-capture.jsonl`. Other examples are reconstructed from source. Anything
still marked **VERIFY** has not been seen on the wire.

### Live results (overleaf.com)

Phase 0 spike on a scratch project owned by a premium account:

| Check | Result |
|---|---|
| Cookie `overleaf_session2`, CSRF from `/project`, GCLB affinity cookie | ✓ |
| `POST /api/project` listing (`id`, `name`, `lastUpdated`, `accessLevel`) | ✓ |
| `joinProjectResponse` (`protocolVersion: 2`) | ✓ `features.trackChanges: true`, `trackChangesVisible: true`, `imageName: "texlive-full:2026.1"` |
| Tracked insert via `meta.tc` | ✓ change id = `tc` + `000001` |
| Comment: `POST /project/:id/thread/:id/messages`, then `{c, p, t}` op | ✓ server broadcast `new-comment(threadId, message)` |
| Ack frames | `6:::2` (no `+`, no data), then `otUpdateApplied {v, doc}` |
| Browser edits received live | ✓ one `otUpdateApplied` per typing burst, ~0.5 s apart |
| `meta` on incoming untracked updates | `source`, `ts`, `user_id` (no `tc`) |
| Untracked browser edit typed inside our tracked insert | Splits our change: the first part keeps its id, the remainder gets a new id (from the browser update's seed) but keeps our `user_id` and `ts` |

The split matters for receipts: after a coauthor types inside an agent insert, some of that
insert is tracked under an id the receipt doesn't list. Group changes by `user_id` and `ts`,
not by id prefix. Whether a coauthor's *tracked* edit carries `meta.tc` on the broadcast is
not yet observed (**VERIFY**); the adapter does not depend on it, since it re-joins the doc to
refresh ranges after any remote update.

### Live results (Community Edition)

| Check | Result |
|---|---|
| Handshake, `joinProjectResponse`, file tree, settings | ✓ |
| `joinDoc` with Latin-1-encoded UTF-8 lines | ✓ |
| Tracked insert via `meta.tc` | ✓ stored; change id = `tc` + `000001` |
| Ack frames | `6:::2` (no `+`, no data) for `applyOtUpdate`, then `otUpdateApplied {v, doc}` |
| Second client's edit received as `otUpdateApplied` with `op` | ✓ |
| Server-side rebase of a stale update (coauthor edit landed mid-compile) | ✓ both edits kept |
| `POST /project/:id/thread/:id/messages` | ✗ 404 on CE (not routed), as predicted |
| `features` | `trackChanges: true`, **`trackChangesVisible: false`**; no `imageName` |

---

## 0. Transport

Overleaf still runs **Socket.IO 0.9** (protocol v1), not Engine.IO. Current npm
`socket.io-client` cannot talk to it. We implement the 0.9 framing ourselves over `ws`
(`src/adapters/realtime/socketio.ts`), following nvim-overleaf.

- Handshake: `GET {base}/socket.io/1/?projectId=<id>&t=<ms>` with the cookie header.
  Body: `sid:heartbeatTimeout:closeTimeout:transports`, e.g. `Xy12…:60:60:websocket,xhr-polling`.
- Socket: `wss://{host}/socket.io/1/websocket/<sid>?projectId=<id>&t=<ms>`, same cookie and `Origin`.
- Frames: `type:id[+]:endpoint[:data]`. Types: 0 disconnect, 1 connect, 2 heartbeat,
  3 message, 4 json, 5 event, 6 ack, 7 error, 8 noop.
  - Event with ack: `5:7+::{"name":"joinDoc","args":["<docId>",-1,{"encodeRanges":true}]}`
  - Ack from server: `6:::7+[null,[…lines…],42,[],{…ranges…},"sharejs-text-ot",{…}]`
    (first element is the error, `null` on success).
  - Heartbeat: server sends `2::`; reply `2::`. Also send one every `0.8 × heartbeatTimeout`.

## 1. Auth

- Cookie: `overleaf_session2` on overleaf.com (`s%3A…` value). CE uses `overleaf.sid`
  by default (`sharelatex.sid` on old installs). We accept a full `Cookie:` string or a bare
  `overleaf_session2` value.
- overleaf.com sits behind Google Cloud Load Balancer: fetch `/socket.io/socket.io.js`
  once and keep the `GCLB` cookie it sets, otherwise the WebSocket upgrade may land on a
  different backend from the handshake (nvim-overleaf does this).
- CSRF: `GET /project` (HTML). `<meta name="ol-csrfToken" content="…">`, also
  `ol-user_id`. Send as header `X-Csrf-Token` on every POST/DELETE.
- **Expiry detection:** `GET /project` with `redirect: manual` returns 302 to `/login`.
  On the socket, the handshake returns 403 or the server emits `connectionRejected`
  with `{message: "not authorized"}`. Both map to `auth_expired`.

## 2. Project listing

- `GET /user/projects` → `{"projects":[{"_id","name","accessLevel"}]}`, archived and
  trashed already removed. No `lastUpdated`.
- `POST /api/project` (CSRF) with `{"page":{"size":200},"sort":{"by":"lastUpdated","order":"desc"}}`
  → `{totalSize, projects:[{id, name, lastUpdated, accessLevel, archived, trashed, owner,…}]}`.
  We use this one and fall back to `/user/projects`. Field names confirmed live on overleaf.com.

## 3. Join a project

Protocol v2: the project id goes in the handshake query; there is no `joinProject` emit.
After connect the server emits:

```
5:::{"name":"joinProjectResponse","args":[{
  "publicId":"P.abc…","permissionsLevel":"owner","protocolVersion":2,
  "project":{
    "_id":"…","name":"Paper","rootDoc_id":"…","compiler":"pdflatex",
    "imageName":"texlive-full:2025.1",            // basename only; year is the TeX Live year
    "rootFolder":[{"_id":"…","name":"rootFolder","docs":[{"_id","name"}],
                   "fileRefs":[{"_id","name","hash","created","linkedFileData"}],
                   "folders":[…]}],
    "features":{"trackChanges":true,"trackChangesVisible":true,…},
    "trackChangesState":false,                    // project/user toggle; only present if features.trackChanges
    "owner":{…},"members":[…]
  }}]}
```

Other server events: `connectionAccepted` (old v1), `connectionRejected`, `forceDisconnect`,
`reciveNewDoc`, `reciveNewFile`, `reciveNewFolder`, `reciveEntityRename`, `reciveEntityMove`,
`removeEntity`, `otUpdateApplied`, `otUpdateError`, `new-comment`, `resolve-thread`,
`reopen-thread`, `delete-thread`, `accept-changes`, `compilerUpdated`, `rootDocUpdated`.

TeX Live year: parse the first 4-digit run in `imageName` (`texlive-full:2025.1` → `2025`).
If `imageName` is absent (CE without sandboxed compiles), use config default.

## 4. Docs: text, version, ranges

`joinDoc(docId, fromVersion, options, cb)`:

- Args: `[docId, -1, {"encodeRanges":true,"supportsHistoryOT":true}]`. `-1` means "current".
  With `fromVersion = n` the server returns the ops since `n` (or errors if Redis no longer
  has them: then rejoin with `-1`).
- Ack: `[err, lines[], version, ops[], ranges, type, {canSkipLeaveDoc:true}]`.
- **Encoding:** for `sharejs-text-ot` docs each line is `unescape(encodeURIComponent(line))`,
  i.e. UTF-8 bytes as Latin-1 code points. Decode with
  `Buffer.from(line, 'latin1').toString('utf8')`. With `encodeRanges: true` the same
  applies to `ranges.changes[].op.i/d` and `ranges.comments[].op.c`.
  **Incoming `otUpdateApplied` ops are not encoded** (plain JSON unicode), and outgoing ops are
  sent as plain unicode. (nvim-overleaf decodes incoming ops too; the Overleaf frontend
  does not. We follow the frontend.)
- `type` is `sharejs-text-ot` (normal) or `history-ot` (projects migrated via
  `overleaf.history.otMigrationStage`). For `history-ot`, `lines` is a `StringFileRawData`
  object (`{content, comments, trackedChanges}`) and updates use a different op format.
  Document-updater still has `TODO(24596): tc support for history-ot`. **v1 treats history-ot
  docs as read-only** (`ot_type_unsupported`).
- Ranges:

```json
{
  "changes": [
    {"id":"6720f1c2a1b2c3d4e5000001","op":{"i":"new text","p":120},
     "metadata":{"user_id":"…","ts":"2026-10-20T…"}},
    {"id":"…000002","op":{"d":"old text","p":140},"metadata":{…}}
  ],
  "comments": [
    {"id":"<threadId>","op":{"c":"quoted text","p":300,"t":"<threadId>"},"metadata":{…}}
  ]
}
```

Positions are in the current document text, which **includes** tracked inserts and
**excludes** tracked deletes (deleted text lives only in the range).

`leaveDoc` is a no-op on current servers (`canSkipLeaveDoc`).

## 5. Sending edits

ShareJS text OT. Op components: `{i, p}` insert, `{d, p}` delete (text must match),
`{c, p, t}` comment. Positions are UTF-16 code-unit offsets (JS string indices) in the
current text. Components in one update are applied sequentially.

```
emit applyOtUpdate(docId, {
  "doc": docId, "op": [{"p":120,"i":"Hello"}], "v": 42,
  "meta": {"tc": "6720f1c2a1b2c3d4e5"},     // only for tracked updates, see §7
  "lastV": 41,                              // optional
  "hash": "<sha1 of 'blob <len>\0<text>'>"  // optional; server checks after apply, VERIFY
})
```

The schema is `z.strictObject`: unknown fields reject the update and **disconnect** the client.

- The ack callback means **queued**, not applied. **(CE live)** `6:::2` — no `+`, no data.
- **Applied** = an `otUpdateApplied` event to the sender with only `{v, doc}` (no `op`),
  where `v` is the version the update was applied **at**. The doc is then at `v + 1`.
- If `v` is behind, document-updater transforms our op against the ops since `v`
  (server-side OT); `otUpdateApplied` then carries the version it landed at.
- Rejection: `otUpdateError` with `(errorMessage, {project_id, doc_id, error})`,
  then the server disconnects us. Examples: `"Delete component does not match"`,
  `"Op too long"`, `"update is too large"`, `"doc not found"`. Recovery: reconnect,
  rejoin the doc with `-1`, rebuild.
- Size limits: document-updater `max_doc_length` = 2 MB; real-time rejects oversized
  updates with `"update is too large"` (exact limit **VERIFY**).

## 6. Incoming edits

`otUpdateApplied` with `{doc, op:[…], v, meta:{source, user_id, ts, tc?}}`, broadcast to
the whole project room; filter by `doc`. `meta.source` is the sender's `publicId`
(ours are the ack-only form). Apply when `update.v === local.version`, then `version++`.
`dup: true` updates are skipped. If `update.v > local.version` there is a gap: rejoin with
`fromVersion = local.version` (or `-1` if that fails).

We never hold unacknowledged local ops while other edits arrive for longer than one
round-trip, so we transform only against a single inflight update (§ adapter).

## 7. Tracked changes

**Tracking is per update.** The client puts `meta.tc = <18 hex chars>` on the update.
`real-time` only checks permissions (`tc` updates need `review` or higher; untracked
need `readAndWrite`). `document-updater`'s `RangesManager` sets
`rangesTracker.track_changes = Boolean(update.meta.tc)` and seeds change ids with it, so:

- change id = `tc + increment` (6 hex, starting at `000001`), in order of the change
  objects created while applying that update. We can predict our own change ids.
- The project-level "track changes" toggle (`trackChangesState`) only controls whether the
  browser adds `tc`; it is not enforced server-side. **This means D2 is satisfiable.**
- Availability: `project.features.trackChanges` (owner's plan) **and**
  `features.trackChangesVisible` (whether the server has the review UI). On CE (live):
  `trackChanges: true, trackChangesVisible: false` — the server stores tracked changes but
  the browser never shows them, so coauthors couldn't review them. On overleaf.com (live,
  premium owner) both are true; free plans are **VERIFY**. We refuse `tracking_unavailable`
  unless both are true.
- Accept: `POST /project/:pid/doc/:docId/changes/accept` `{"change_ids":[…]}` (CSRF).
  Not in CE's router (Server Pro / overleaf.com module).
- Reject (text docs): client-side. Sort changes by position descending; for a tracked
  insert send an untracked `{d: text, p}`; for a tracked delete send untracked
  `{i: text, p, u: true}` (`u` = undo, makes RangesTracker drop the tracked delete instead of
  inserting new text). Optionally `POST /project/:pid/doc/:docId/changes/reject`
  for notifications (private API on CE; skip).

## 8. Comments

Anchors live in doc ranges; messages live in the chat service.

- List: `GET /project/:pid/threads` →
  `{"<threadId>":{"messages":[{"id","content","timestamp","user_id","user":{"id","first_name","last_name","email"}}],"resolved":bool,"resolved_at","resolved_by_user"}}`.
- Create: `threadId = RangesTracker.generateId()` (24 hex);
  `POST /project/:pid/thread/:threadId/messages` `{"content":"…"}`; then
  `applyOtUpdate` with op `[{"c":"<anchor text>","p":<pos>,"t":"<threadId>"}]` (no `tc`).
- Reply: `POST /project/:pid/thread/:threadId/messages` `{"content":"…"}`.
- Resolve: `POST /project/:pid/doc/:docId/thread/:threadId/resolve`.
- Reopen / delete: `…/reopen`, `DELETE /project/:pid/doc/:docId/thread/:threadId`.
- Broadcasts: `new-comment(threadId, message)`, `resolve-thread(threadId, user)`.
- Not in CE's router (live: 404). On overleaf.com (live) create works and broadcasts
  `new-comment`; resolve and accept are not yet exercised (**VERIFY**).

## 9. Binary files and the file tree

- Binary: `GET /Project/:pid/file/:fileId` (cookie). Returns the bytes.
- Doc plain text: `GET /Project/:pid/doc/:docId/download`.
- Entities by path: `GET /project/:pid/entities` → `{entities:[{path:"/main.tex",type:"doc"|"file"}]}`.
- New doc: `POST /project/:pid/doc` `{"name","parent_folder_id"}` → `{_id,name}`.
- Rename: `POST /project/:pid/{doc|file|folder}/:id/rename` `{"name"}`.
- Move: `POST /project/:pid/{doc|file|folder}/:id/move` `{"folder_id"}`.
- Tree changes arrive as `reciveNewDoc(folderId, doc)`, `reciveNewFile(folderId, file)`,
  `reciveEntityRename(id, name)`, `reciveEntityMove(id, folderId)`, `removeEntity(id)`.
- v1 uses read, list and tree events only. No create/rename/move tools are exposed.

## 10. Compile

`POST /project/:pid/compile` (CSRF, rate limited) with
`{"rootDoc_id","draft":false,"check":"silent","incrementalCompilesEnabled":true}` →
`{status:"success"|"failure"|…, outputFiles:[{path,url,type,build}], compileGroup, …}`.
Fetch `output.log` from the returned `url`. Used only for the optional Phase 3 parity
check; the gate compiles locally.

## 11. Rate limits, disconnects, gaps

- Handshake / join are rate limited per user (`joinProject`, ~45/min on overleaf.com,
  **VERIFY**). Back off exponentially (1 s → 16 s, 10 tries).
- `forceDisconnect(message, {delay})` from server (deploys, `"project deleted"`, revoked
  access): reconnect after `delay`, unless the message says access was revoked.
- `serverPing` / `clientTracking.*` are optional; we don't send cursor updates.
- After reconnect: rejoin each open doc with `fromVersion = localVersion`; the ack returns
  missing ops in `ops[]`; apply them. If the server can't (`ClientRequestedMissingOpsError`),
  rejoin with `-1` and treat as a full replacement (the change log records it as an external change).
- Gap during a session: `otUpdateApplied.v > local.version` → same catch-up path.

## 12. CE vs overleaf.com differences (live unless noted)

| Area | CE | overleaf.com |
|---|---|---|
| Cookie name | `overleaf.sid` (configurable) | `overleaf_session2` |
| GCLB affinity cookie | not needed | set and used |
| Tracked changes UI | hidden (`trackChangesVisible: false`) | visible on premium (free plans unverified) |
| Thread messages | not routed (404) | works |
| `/changes/accept`, thread resolve | not routed (source) | not yet exercised |
| `imageName` | absent | `texlive-full:2026.1` |
| history-ot docs | possible after migration (source) | not seen; test doc was `sharejs-text-ot` |

## 13. Terms of service

Not decided here. Overleaf's terms need review for automated clients acting through a user's
session cookie. Flagged to the owner (spec §19).
