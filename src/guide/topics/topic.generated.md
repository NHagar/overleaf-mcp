# Generated files

A file is generated if one of its first five lines is:

```
% generated-by: <script path> from <data path>
```

Edits to generated files are refused `generated_file`. The refusal names the script: tell the user to change the data or script and rerun it.

Convention for computed results:

- Put each computed value in a generated `numbers.tex`, one `\newcommand` per value, e.g. `\newcommand{\nArticles}{12{,}000}`, `\input` from the preamble.
- Put generated tables in their own files with the same header, `\input` where they belong.
- In prose, use the macros (`\nArticles{}`) instead of typing numbers, so a rerun updates the paper.
