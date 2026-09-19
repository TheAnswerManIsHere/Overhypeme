---
name: get_check_runs carries no head_sha — for an Actions job, get_workflow_job does
description: pull_request_read method get_check_runs returns no head_sha, and neither does get_check_run. For a check run produced by GitHub Actions, re-fetch the same id through actions_get get_workflow_job, which carries head_sha. For a check run from any other App there is no known MCP route to its head_sha. The collection is also paginated — total_count is the collection size, not proof of a single page.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

## Rule

When a readiness snapshot needs check runs bound to a commit:

1. **Page the collection to completion.** `pull_request_read`
   (`method: "get_check_runs"`) takes `page` / `perPage` like every other
   method. Its `total_count` is the size of the **collection**, not a promise
   that the collection fit in one response — so collect until the runs you
   hold equal `total_count`, and never attest `complete.checkRuns = true`
   from a first page alone.
2. **For each run produced by GitHub Actions**, re-fetch the same id through
   `actions_get` (`method: "get_workflow_job"`, `resource_id` the id). That
   response carries `head_sha` and `head_branch`.
3. **For a check run produced by any other GitHub App** — a coverage,
   deployment or scanning integration — step 2 does not apply and **no
   substitute is known** (see the limit below). Do not assume the repository
   you are in has only Actions checks.

## The mechanic

`get_check_runs` returns, per run: `id`, `name`, `status`, `conclusion`,
`html_url`, `details_url`, `started_at`, `completed_at`. **No `head_sha`, and
no other field naming a commit** — `html_url` embeds a *run* id, not a sha.

`get_workflow_job` on the same id returns `head_sha` and `head_branch` beside
the same `name` / `status` / `conclusion`. Measured on AI-Handbook PR #78
(2026-09-11), job ids `103345180809` and `103345181037`: both returned
`head_sha` for the PR's head commit.

**The limit, measured rather than assumed.** `get_check_run` (the single-run
tool) is the obvious general-purpose route and it does **not** help: called on
the same id it returns `conclusion`, `details_url`, `id`, `name`, `output` and
`status` — again no `head_sha`. So for a non-Actions check run there is no
known MCP path to its head commit, and a snapshot that needs one cannot be
assembled for it by this route. Say so rather than inventing the field.

## Why the binding matters rather than being pedantry

The handbook's former readiness gate refused on exactly this:

> `N check run(s) carry no head_sha, so they cannot be tied to <sha> -- capture head_sha with each run`

That gate was removed in the #89 cut — GitHub's own ruleset now holds the
merge — but the refusal was load-bearing for a reason that has nothing to do
with it, and the reason is why this note survives its consumer. A readiness snapshot's collections come from
separate calls, so **green checks read before a push, with the PR metadata
read after it, produce a receipt bound to the new commit whose CI item
describes the old one** — and the branch-tip comparison then agrees, because
it is looking at the new commit too.

So an agent that reaches for the obvious call, finds no `head_sha`, and fills
one in from the PR metadata it already holds is **fabricating the binding the
check exists to verify**. The two-call route is the difference between an
observed value and an assumed one — and where the two-call route does not
exist, the honest output is a refusal, not a filled-in field.

The pagination half fails the same way from the other end: attesting
`complete.checkRuns = true` after one page can omit a pending or failing
later-page check and mint a READY receipt for a PR that is neither.

## Related

- **This is live for #95 and #96.** Both rebuild a path that hands live PR
  state to a dispatched session, and "which commit does this check run
  describe" is exactly the question an assembled view has to answer honestly.
  The snapshot assembler this note used to warn about never emitted
  `checkRuns` at all; whatever replaces it should either capture `head_sha`
  with each run through the two-call route above, or say it could not.
