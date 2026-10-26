# refusal.reflow

The edit changes line breaks between words that did not change (reflowing a paragraph). That buries the real change in a noisy tracked diff. `current.near` shows where.

Recovery: keep untouched lines exactly as they are, including where they break. Replace only the words you are changing, with `find`.
