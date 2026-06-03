---
name: Test-data purge (api-server)
description: How leaked test rows in the real dev DB are permanently swept, and why per-file teardown alone was insufficient.
---

# Test data leaks into the real dev DB

Tests run against the REAL dev database (heliumdb) — there is no separate test DB or
transaction rollback. Leaked test rows accumulate across runs and cost the user money.

## Why per-file teardown was not enough
Per-file cleanups deleted parents (users) by a broad `LIKE prefix%` but deleted children
only by IDs tracked within that one run. Orphans left by a prior/crashed/interrupted run
caused FK violations (e.g. `memes_created_by_id_users_id_fk`) that aborted cleanup midway,
leaving rows forever. The shard time-limit wrapper only WARNS — it does not kill — so an
interrupted shard skips its own teardown entirely.

## The permanent fix
A single FK-safe purge (`src/__tests__/helpers/purgeTestData.ts`) deletes ALL child rows
before test users, matching `users.id LIKE 't%'`. It is wired as both a pre-sweep and a
post-sweep (+ EXIT trap) in `scripts/run-tests-sharded.sh`, OUTSIDE the parallel-shard
window so there is no cross-shard race.

**Why `id LIKE 't%'` is safe:** real user IDs are UUIDs (hex 0-9a-f) and can never start
with `t`; only synthetic test users use a `t…` prefix. Verified against live data.

## Directly-inserted test facts must use a `t`-prefixed text
Facts inserted without a `submitted_by_id` (null submitter) carry no user-marker, so the
user-based purge misses them. The global purge catches them via:
`submitted_by_id IS NULL AND text LIKE 't%'`
Every test file that inserts facts directly MUST prefix the fact text with a lowercase `t`
(e.g. `t-cmr-fact-`, `t-ipp-fact-`, `t_p4s_fact_`). Real production facts with null
submitter start with `{NAME}`, `When`, `Firearms`, etc. — never `t`.

**Why:** `createMemeRecord.test.ts` used `"Test {NAME}"` and `imagePromptPreview.test.ts`
used `"{NAME} bench-presses..."` — both had null submitters, so 11 facts leaked and
showed in the admin UI. Fixed by changing both to use `t-cmr-fact-` / `t-ipp-fact-`
prefixes and adding `AND isNull(submittedById) AND text LIKE 't%'` to the global purge.

## The recurring trap: stay exhaustive over non-cascade user FKs
The purge must delete from EVERY table with a user-referencing FK that lacks
`onDelete: cascade`/`set null` — those are the only ones that block `DELETE FROM users`.
Miss one and a leaked row there recreates the exact FK-abort failure. When ANY new
user-FK column is added to the schema without an onDelete clause, it MUST be added to
the purge. To re-audit: grep the schema for `references(() => usersTable.id` and treat
every match WITHOUT an onDelete option as a required purge target.

**Why:** an earlier version missed `external_links.added_by_id` and
`stripe_checkout_request_ledger.user_id` (both no onDelete) — caught in review.

## Gotchas
- SQL table names are not intuitive: reviews=`pending_reviews`; membership is split into
  `subscriptions` / `lifetime_entitlements` / `membership_history`.
- Directly-inserted test facts (serial int id, no submitter) carry no marker and are NOT
  globally purged — only facts with a test submitter are. Per-file teardown handles the rest.
- The sharded runner exits 1 even when all tests pass; trust `ℹ fail 0`, not the exit code.

**Why not a separate test DB / tx rollback:** too invasive for the scope; the purge sweep
fully solves the leak with minimal blast radius.
