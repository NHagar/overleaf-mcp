# Style: edits coauthors can review

- Change only what the user asked for. Keep the authors' sentences; prefer replacing a phrase with `find` over replacing a whole paragraph.
- Never reflow untouched lines. If the file puts one sentence per line, keep that: new sentences go on new lines; don't join or split existing lines.
- Match the file's citation command (`\citep`, `\parencite`, …) and reference style (`\cref` vs `Figure~\ref`).
- Don't type computed numbers. If the project has `numbers.tex` (or another generated file), use its macros (e.g. `\nArticles{}`) instead of literal figures. If a needed macro doesn't exist, tell the user; don't add it to a generated file.
- Don't add packages or macros without asking; that is refused as `preamble_change` unless the user agreed.
- One section per edit. Several small edits are easier to review than one large one.
