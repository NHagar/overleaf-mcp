# overleaf-mcp

Let an AI assistant work on your Overleaf papers without stepping on your coauthors.

overleaf-mcp is an MCP server. Connect it to Claude (or any MCP client) and the assistant can
read your Overleaf projects and edit them, while coauthors keep working in the browser.

## What your coauthors see

- **Every edit is a tracked change.** Coauthors accept or reject the assistant's work in
  Overleaf's review panel, like any other suggestion.
- **Small, targeted edits.** The assistant changes the words you asked about, not whole
  paragraphs. It can't rewrite more than a quarter of anyone's paragraph unless you ask for a
  rewrite.
- **No collisions.** If someone changed a passage after the assistant read it, the edit is
  refused, and the assistant re-reads before trying again. People typing elsewhere in the
  same file are unaffected.
- **It won't break the build.** Each edit is compiled first; an edit that would add a LaTeX
  error is refused.
- **References stay intact.** It won't add a `\ref` to a label that doesn't exist, or remove
  a label something still refers to. Citations missing from your `.bib` are flagged to you.
- **Comments are respected.** The assistant can read review comments and reply in threads.
  It resolves threads or accepts changes only when you ask it to in chat.

## What you need

- **Node.js 20 or newer.**
- **Docker**, to check that edits compile. The first check downloads a TeX Live image
  (about 3 GB) matching your project's TeX Live version. Without Docker, edits still work,
  but the assistant will tell you they weren't compile-checked.
- **An Overleaf account.** On overleaf.com, tracked changes may need a paid plan.
  Self-hosted Overleaf Community Edition doesn't show tracked changes, so there the assistant
  will ask before making untracked edits.

## Install

```bash
gh repo clone NHagar/overleaf-mcp
cd overleaf-mcp
npm install
npm run build
```

## Connect your Overleaf account

The server signs in with your browser's Overleaf session cookie. It never asks for your
password.

1. Sign in at [overleaf.com](https://www.overleaf.com).
2. Open your browser's developer tools and find the cookies for `www.overleaf.com`:
   Chrome or Edge: **Application → Cookies**; Firefox or Safari: **Storage → Cookies**.
3. Copy the value of `overleaf_session2` (it starts with `s%3A`).
4. Save it where only you can read it:

```bash
mkdir -p ~/.overleaf-mcp && (umask 077 && pbpaste > ~/.overleaf-mcp/cookie)
```

The cookie works like a password: anyone who has it can use your Overleaf account. Don't
share it or commit it. It stops working when you sign out of Overleaf or the session
expires; the assistant will tell you, and you repeat the steps above.

## Add it to Claude

Claude Code:

```bash
claude mcp add overleaf -- node /path/to/overleaf-mcp/dist/server.js
```

Claude Desktop, or another MCP client: add a server that runs
`node /path/to/overleaf-mcp/dist/server.js`.

Then just ask:

- "List my Overleaf projects."
- "In my CHI paper, tighten the second paragraph of the introduction."
- "Add a sentence after Figure 2 explaining the pipeline, and cite Smith 2020."
- "What did my coauthors change since we last talked?"
- "Show me the open review comments on the Methods section and draft replies."

The assistant reports anything it was warned about, such as an unknown citation or an edit
that couldn't be compile-checked.

## Settings

Everything works without configuration. To change defaults, create
`~/.overleaf-mcp/config.jsonc`:

```jsonc
{
  // Projects the assistant must never open (IDs from the project's Overleaf URL).
  "denylist": ["<project id>"],

  // How much of an existing paragraph one edit may rewrite (0.25 = 25%).
  "diffBudget": { "threshold": 0.25 },

  // Self-hosted Overleaf: point at your server, and save the overleaf.sid cookie instead.
  "baseUrl": "https://www.overleaf.com",

  "compile": {
    "enabled": true,          // set false to skip compile checks
    "timeoutSeconds": 120
  }
}
```

You can also set the cookie with the `OVERLEAF_COOKIE` environment variable instead of the
file.

The server keeps a local copy of each opened project in `~/.overleaf-mcp/mirrors` for
compiling. It logs each edit, with at most a short snippet of text, to `~/.overleaf-mcp/audit.jsonl`.

## Good to know

- **Numbers from scripts.** Files that start with
  `% generated-by: <script> from <data>` are never edited; the assistant will tell you
  which script to rerun instead. Keep computed values in a generated `numbers.tex` and the
  assistant will use its macros rather than typing figures.
- **Packages and macros.** The assistant asks before adding or removing `\usepackage` lines
  or macro definitions.
- **Some newer Overleaf projects** use a document format the assistant can read but not yet
  edit. It will say so if it hits one.
- **It only edits.** It can't share projects, change settings, create or delete projects, or
  touch your account.

## For developers

Run the tests with `npm test`. How the server talks to Overleaf is documented in
[docs/PROTOCOL.md](docs/PROTOCOL.md); design choices are in [docs/DECISIONS.md](docs/DECISIONS.md).
