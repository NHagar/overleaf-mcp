# refusal.tracking_unavailable

The project's plan or server does not support tracked changes, so the edit cannot be sent as one. The server never silently sends untracked edits.

Recovery: tell the user. Retry with `"tracked": false` only if the user explicitly agrees to untracked edits.
