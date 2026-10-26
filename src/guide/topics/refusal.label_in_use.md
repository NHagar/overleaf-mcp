# refusal.label_in_use

The edit removes a `\label` that other text still references. `current.referencedIn` lists the files.

Recovery: keep the label, or use `batch` to update every reference in the same change (for a rename, change the label and all `\ref`s together).
