# refusal.preamble_change

The edit adds or removes a package (`\usepackage`, `\RequirePackage`), changes `\documentclass` options, or adds/removes a macro definition (`\newcommand`, `\renewcommand`, `\def`, `\DeclareMathOperator`). `current.added` / `current.removed` list them.

Recovery: ask the user whether to make that change. Only if they agree, retry with `"allowPreamble": true`. Often you can avoid it by using commands the project already defines.
