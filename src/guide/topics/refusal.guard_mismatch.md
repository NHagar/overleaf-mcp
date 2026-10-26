# refusal.guard_mismatch

The unit changed since you read it (its hash differs from your `ifHash`, or a coauthor edited it after your `ifVersion`). `current` holds the unit as it is now.

Recovery: read `current.text` (or `read` kind `unit`), check whether the change you wanted still makes sense with the coauthor's edit, rebuild the op against the new text and hash, and use the file's current version as `ifVersion`. Do not overwrite a coauthor's change without telling the user.
