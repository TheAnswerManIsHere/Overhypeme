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
