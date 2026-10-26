# Compiling

The server keeps a local copy (mirror) of the project and compiles it with `latexmk` in a TeX Live Docker image matching the project's TeX Live year.

## The compile gate

Before every edit is sent, the mirror is compiled with the edit applied, and the log is compared with the last baseline (the project as it stood):

- New LaTeX errors (`!` lines) or a missing PDF → refused `compile_regression`; `current.newErrors` lists them with file, line and message. Nothing was sent.
- New non-fatal warnings (overfull boxes, undefined citations, …) → the edit lands with `compile_warning_new` warnings.
- Errors that were already there before your edit don't block you.
- If the compiler can't run (no Docker, no root document) the edit lands with `compile_skipped`; if it is too slow, `compile_timeout`. Tell the user the edit was not compile-checked.

## The compile tool

`compile` `{"projectId":"…","units":["fig:pipeline"]}` compiles the current mirror and returns new errors and warnings relative to the baseline, the full log path, and PNG page images (110 dpi) of pages where the named units appear. Use it to check how a figure or table looks after an edit.
