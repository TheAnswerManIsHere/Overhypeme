# The review gate matches an assessment to a round by Codex's comment ids

**The gotcha.** The `id` of each finding in `review-proxy.mjs --findings-file`
is not a free label. It is copied into the assessment's facts line
(`findings `…``), and `scripts/review-gate.mjs` (`satisfiedAt`) matches an
assessment to a findings round by those ids against the numeric ids of the
review comments the Codex review owns. Label the findings `F1`, `F2` and both
assessments are posted, read and acted on, while the required `Review gate`
status still says "Astra and Fable missing".

**The fix.** Use the review comments' numeric ids (`get_review_comments`
gives each comment's `html_url`, ending `#discussion_r<id>`) as the finding
ids. If the labels are already posted, edit only the facts line of each
posted assessment to name the ids and say so on the PR: the assessment's
creation time is unchanged, so it still predates the fix's push. A fresh
assessment posted after the push satisfies the gate too, but the gate then
notes that push as preceding the assessments (KITT's review-gate amendment 1,
2026-11-25: a note, not a failure), and the round's `review-action` block has
to disclose that push, saying the assessments preceded it under ids the gate
could not match. Editing the facts line avoids both.

Measured on PR #971 (compiler review, Phase 2), round 1, 2026-11-16.
