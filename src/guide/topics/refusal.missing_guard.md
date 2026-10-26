# refusal.missing_guard

You asked to replace, delete or move a whole unit without `ifHash`. Whole-unit changes must prove you saw the current text.

Recovery: `read` kind `unit` for the target (or use the hash from the outline / `current.hash`), then retry with `"ifHash": "<hash>"` on the op. If you only need to change a phrase, use a `find` target instead.
