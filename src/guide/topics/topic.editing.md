# Editing

`update` takes `projectId`, `file`, `ifVersion` (the file's `ver` from your last read), and ordered `ops`. All ops in a call are checked against the text you read and applied together, or nothing is applied.

## Ops

| op | fields | effect |
|---|---|---|
| `insert` | `target`, `side` (`before`/`after`), `content` | Insert text. With a unit target the content becomes its own paragraph block. |
| `replace` | `target`, `with` | Replace the target text. |
| `delete` | `target` | Remove the target. |
| `move` | `target` (unit), `to: {kind:"unit", id, side}` | Move a whole unit. |

## Targets

- `{"kind":"find","text":"exact words","within":"sec:methods"}`: exact quoted text. Quote enough words to be unique, or add `within` (a unit ID) or `nth` (1-based). Must not cross a unit boundary. Best for small changes inside a sentence.
- `{"kind":"unit","id":"fig:pipeline"}`: a whole unit. `replace`, `delete` and `move` of a whole unit need `"ifHash"` (the unit's current hash). For a section, `side: "after"` means after its last child.
- `{"kind":"lines","start":12,"end":14,"ifHash":"…"}`: only for files the outline marks `parse='fallback'`; `ifHash` is the containing unit's hash.

## Unit IDs

A section or environment with its own `\label{x}` has ID `x`. Others have path IDs such as `main.tex/§2.1/¶3` (third paragraph of subsection 2.1) or `main.tex/§2/env1`. Path IDs shift when units are added before them; always pass `ifHash` so the server can find a unit that moved.

## Example

```json
{"projectId":"…","file":"main.tex","ifVersion":388,"ops":[
  {"op":"replace","target":{"kind":"find","text":"12,000 articles","within":"sec:methods"},"with":"\\nArticles{} articles"},
  {"op":"insert","target":{"kind":"unit","id":"fig:pipeline"},"side":"after","content":"As Figure~\\ref{fig:pipeline} shows, …"}
]}
```

## Results

Success: `{"ok":true,"ver":…,"files":[{file,version}],"receipts":[{op,units:[{id,hash}],trackedChanges:[…]}],"warnings":[…]}`. Use the new hashes and file version for follow-up edits. Report every warning to the user.

Refusal: `{"ok":false,"code":"…","detail":"…","current":{…}}`. Nothing was sent. `current` holds what you need to rebuild the edit. Read `refusal.<code>`.

## batch

`batch` takes `projectId` and `edits` (each an `update` input without `projectId`), at most one per file. Everything is checked first; if any check refuses, nothing is sent. If sending fails part-way, edits already sent are reverted and you get `batch_partial_reverted`. Use it for changes that must land together, such as renaming a label and every `\ref` to it.

## bib

`bib` `{"action":"add","file":"refs.bib","entry":"@article{key, …}"}` adds one entry in key order as a tracked change. `{"action":"check","keys":[…]}` reports which keys exist.
