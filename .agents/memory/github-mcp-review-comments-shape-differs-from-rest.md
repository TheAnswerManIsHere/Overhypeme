---
name: GitHub MCP pull_request_read shape differs materially from the REST API
description: get_review_comments groups by thread with a bare author string, no numeric id, no in_reply_to_id, and no pull_request_review_id — and the reviewer bot's login has an inconsistent [bot] suffix across methods.
---

## Rule
Never assume the GitHub MCP server's `pull_request_read` tool returns the
same shape as the equivalent REST endpoint. Verify against a real, live call
before writing any code that maps MCP output into a REST-shaped structure.

## What's actually different (verified against this repo's own PR #270)
- `get_review_comments` returns comments **grouped into `review_threads`**,
  not a flat array like `GET /pulls/{n}/comments`.
- Each comment's author is a **bare string** in an `author` field — not
  `user: { login }`.
- There is **no numeric `id` field at all.** The only way to recover the
  REST-equivalent id is to regex the `#discussion_r<digits>` suffix off the
  comment's `html_url`.
- There is **no `in_reply_to_id`.** You have to infer it structurally: the
  first comment in a thread is the root finding; every later comment in the
  same thread is a reply to it. This is a workflow convention (one reviewer
  opens a thread, one author replies), not a general GitHub guarantee for
  arbitrarily-authored threads.
- There is **no `pull_request_review_id`** — if you need to correlate a
  comment to the review event that produced it, you have to approximate it
  yourself (e.g. the latest `get_reviews` entry by the same author,
  submitted at or before the comment's `created_at`).
- **The reviewer bot's login is spelled two different ways depending on the
  method**: `get_reviews` returns `chatgpt-codex-connector[bot]` (with the
  `[bot]` suffix) as the review author's login, but `get_review_comments`
  returns the bare `chatgpt-codex-connector` (no suffix) as the comment's
  `author` string. An exact-match lookup between the two silently finds
  nothing for every one of the bot's own comments — normalize both sides
  (strip a trailing `[bot]`) before comparing.

## The flags describe THREAD state, not CODE state (PR #503)
Shape isn't the only thing that misleads. `get_review_comments` returns a
resolved flag and an outdated flag per thread, and both describe **the
conversation**, not the code.

**Mind the field name — this call has two spellings, and neither is
`resolved`.** A live `get_review_comments` response observed 2026-08-19 returns
**`is_resolved` / `is_outdated` / `is_collapsed`** (snake_case) on each thread,
while the tool's own description advertises **`isResolved` / `isOutdated` /
`isCollapsed`**. `scripts/review-loop-record.mjs` reads `thread.isResolved` off
a captured snapshot and emits its own flattened `resolved` field, so all three
spellings are live in this repo at different layers. **Check the shape of the
snapshot in front of you** — a miss here reads `undefined`, which the record
maps to "resolution unknown" rather than erroring.

- **A thread not marked resolved does not mean "the finding was never
  fixed."** It means nobody marked the thread resolved. A finding that was
  fixed in code but whose thread reply is still outstanding is
  **shape-identical** to one that was ignored.
- **A thread not marked outdated does not mean "recent commits didn't touch
  this."** It is GitHub's judgement about whether the anchored diff hunk still
  applies, not a statement about whether the defect was addressed.

This is not hypothetical: PR #503's fresh-context adjudicator reasoned from a
mechanical record built on these fields and drew both wrong conclusions — that
two fixed findings were unfixed, and that the commits since the last pass had
not touched them. The numbers were right; the fields invited a reading they do
not support. If a consumer needs *code* state, it has to come from the diff,
not from thread metadata — and if a record surfaces these fields to a reader,
each one needs a note saying what it is and what it is not.

A third field with the same problem: **`sinceLastReview` (branch movement) is
not the PR's diff.** After a merge from the base branch it includes the base
branch's own already-reviewed files, which an adjudicator read as unreviewed
surface.

## Why it's dangerous
Code written against the REST shape (or against an assumed/remembered MCP
shape) will look like it works — it won't throw — while silently producing
zero or wildly wrong counts, because every field access resolves to
`undefined` and downstream `?? []`/`?.` fallbacks swallow the failure instead
of surfacing it.

## How to avoid
- Make one real MCP call against a live PR and inspect the actual response
  before writing a shape-mapping layer.
- Validate the assembled structure's *shape* (are the expected fields
  present and the right type?) separately from whether it's *complete*
  (has every page been fetched?) — an attestation of completeness doesn't
  prove the underlying data exists.
- See `scripts/loop-metrics.mjs`'s `flattenMcpThreads()` and
  `assertMcpSnapshotShape()` for a worked, tested example of mapping this
  exact shape into a REST-like one.
