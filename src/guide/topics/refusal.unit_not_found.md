# refusal.unit_not_found

No unit has that ID, or a path ID now points at a different unit and no unit in the file has your `ifHash`. Path IDs (like `main.tex/§2/¶3`) shift when units are added or removed before them.

Recovery: `read` kind `outline` for the file (`current.outline` may already have it), find the unit by its lines or title, and retry with its current ID and hash.
