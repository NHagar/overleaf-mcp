# overleaf-mcp

An MCP server that lets an AI agent read and edit Overleaf LaTeX projects safely while
coauthors are working in them.

- Parses LaTeX into addressable units (sections, environments, paragraphs) with stable IDs
  and content hashes.
- Refuses edits made against stale content.
- Sends edits as **tracked changes** by default.
- Compiles a local mirror before sending and refuses edits that add LaTeX errors.
- Checks `\ref`/`\label`, citations, and preamble changes; caps how much of a coauthor's text
  one edit may rewrite.
- Ships its own manual through the `guide` tool.

Spec: the implementation follows the project spec (Phases 0–3). Protocol notes are in
[docs/PROTOCOL.md](docs/PROTOCOL.md); deviations and open items in
[docs/DECISIONS.md](docs/DECISIONS.md).

## Status

| Phase | State |
|---|---|
| 0 Protocol spike | `docs/PROTOCOL.md` from Overleaf's source, verified live on Community Edition (tracked change via `meta.tc` confirmed). **Not yet run against overleaf.com.** |
| 1 Read path | Done. Real-time adapter, outline, IDs, hashes, all `read` kinds, `guide`. |
| 2 Write path | Done. `update`, full pipeline, diff budget, checks, compile gate, audit log, all guide topics. |
| 3 Batch, comments, bib | Done. Overleaf compile parity check not implemented (optional). |
| 4 Git adapter | Not started. |

Tests run against an in-memory backend and a fake Socket.IO 0.9 Overleaf server. Opt-in
suites run real `latexmk` in Docker and a live Overleaf Community Edition instance
(`test/ce.test.ts`). overleaf.com has not been tested.

## Requirements

- Node 20+
- Docker, for the compile gate (TeX Live images: `texlive/texlive:TL<year>-historic`, about
  3 GB each, pulled on first compile). Without Docker, edits still go through with a
  `compile_skipped` warning.
- `pdftoppm` (poppler) on the host for page images; otherwise the TeX Live image's copy is used.

## Setup

```bash
npm install
npm run build
```

Give the server your Overleaf session cookie. In the browser, open Overleaf, open developer
tools → Application → Cookies, and copy the value of `overleaf_session2` (overleaf.com) or
`overleaf.sid` (Community Edition / Server Pro).

```bash
mkdir -p ~/.overleaf-mcp && umask 077 && pbpaste > ~/.overleaf-mcp/cookie
```

The file must be mode 600. Or set `OVERLEAF_COOKIE` in the environment. The server never logs
it. When it expires, tools return `auth_expired`; paste a fresh one.

Optional config at `~/.overleaf-mcp/config.jsonc` (or `OVERLEAF_MCP_CONFIG`):

```jsonc
{
  "backend": "realtime",
  "baseUrl": "https://www.overleaf.com",
  "auth": { "cookieFile": "~/.overleaf-mcp/cookie" },
  "denylist": [],                         // project IDs the server must never touch
  "diffBudget": { "threshold": 0.25 },
  "compile": {
    "enabled": true,
    "images": { "2025": "texlive/texlive:TL2025-historic" },
    "defaultImage": "texlive/texlive:latest",
    "timeoutSeconds": 120,
    "mirrorDir": "~/.overleaf-mcp/mirrors"
  },
  "auditLog": "~/.overleaf-mcp/audit.jsonl"
}
```

Register with an MCP client, e.g. Claude Code:

```bash
claude mcp add overleaf -- node /path/to/overleaf-mcp/dist/server.js
```

## Tools

| Tool | Purpose |
|---|---|
| `guide` | The manual. Agents should read `topic.index` first. |
| `read` | `projects`, `outline`, `unit`, `search`, `changes` (since a version), `bib` |
| `update` | Ordered ops on one file: `insert`, `replace`, `delete`, `move`, by quoted text, unit ID, or line range |
| `batch` | Edits across files; checked together, reverted together on a send failure |
| `compile` | Compile the mirror; new errors/warnings and page images for named units |
| `bib` | Add an entry in key order; check keys |
| `comments` | List, create, reply; resolve and accept/reject only with `askedInChat: true` |

## Phase 0 spike

Run this against a scratch project you own. It inserts one tracked sentence and one comment,
then prints edits you make in the browser for 60 seconds, and records the wire traffic to
`spike-capture.jsonl`:

```bash
OVERLEAF_COOKIE='overleaf_session2=…' npx tsx scripts/phase0-spike.ts <projectId> --yes
```

Then check the browser's review panel. If the sentence is not shown as a tracked change,
stop: decision D2 depends on per-update tracking.

## Development

```bash
npm test                                   # unit + fake-server tests
npx tsc -p tsconfig.test.json              # typecheck src, tests and scripts
DOCKER_TESTS=1 npx vitest run test/docker.test.ts   # real latexmk
CE_URL=http://localhost:8090 CE_COOKIE_FILE=… CE_PROJECT=… npx vitest run test/ce.test.ts  # live CE
npx tsx scripts/golden.ts                  # regenerate fixture outlines (review the diff)
```

Layout follows the spec: `src/adapters` (backend interface, real-time and in-memory
backends), `src/model` (parser, IDs, hashes), `src/edit` (ops, pipeline, budget),
`src/checks`, `src/compile`, `src/feed`, `src/audit`, `src/guide/topics`, `src/tools`.
