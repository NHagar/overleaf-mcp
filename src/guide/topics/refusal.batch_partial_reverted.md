# refusal.batch_partial_reverted

Sending one edit of a batch failed after earlier edits had been sent. The server reverted the earlier edits. `current` lists the failed file, reverted files, any that could not be reverted, and edits never sent.

Recovery: tell the user what happened, especially any `failedReverts`. Then `read` kind `changes`, rebuild the batch on the current text, and retry once.
