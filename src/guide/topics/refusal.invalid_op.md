# refusal.invalid_op

The request was malformed: a missing field, a `find` that crosses a unit boundary, a `lines` target on a normally parsed file, a move relative to itself, comment anchors that are not 3–6 words, and similar. `detail` says which.

Recovery: fix the request as `detail` describes. See `topic.editing`.
