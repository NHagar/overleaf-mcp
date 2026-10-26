# refusal.over_budget

The edit rewrites more than the allowed share (default 25%) of an existing unit's characters. This protects coauthors' text from wholesale rewrites. `current` has the unit, the ratio and the threshold.

Recovery: make a smaller edit that keeps the author's sentences and changes only what was asked; split large changes into several targeted `find` replacements. Pass `"rewrite": true` only if the user explicitly asked you to rewrite this text. Inserting new text is never limited.
