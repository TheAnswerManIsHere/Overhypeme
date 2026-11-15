---
name: A migration test's "before" state must keep the rules the migration retires
description: A data-move migration that strips data an older CHECK still requires fails on any real database with rows, but its test passes if the rebuilt "before" state leaves that CHECK out. Reinstall the old rule NOT VALID in the test's before-state, and drop it in cleanup.
---

# A migration test's "before" state must keep the rules the migration retires

**What happened (PR #956 — Three gags, increment 1, round 1).** Migration
0139 moved every fact's gag out of `facts.enrichment`, then dropped the old
`facts_active_requires_concept` CHECK. That CHECK required an active fact's
enrichment to hold a scene. A CHECK is enforced the moment a row is written,
so the strip violated it, the migration rolled back, and the app would not
have started on any database with live facts.

**Why the tests were green.** CI builds every database from empty, so the
data move found nothing to move. The migration's own test rebuilt the "before"
state by dropping the new triggers and CHECKs, but it never put the old CHECK
back, so it ran the move against a shape no real database has.

**The rule.**
- **Order inside the migration:** drop a retired rule as its own statement
  before the data move, outside any early exit, in the same transaction.
- **The test's before-state:** reinstall the retired rule `NOT VALID`. It is
  still enforced on writes, but other suites' rows in the shard don't trip it.
  Drop it in cleanup, so a failing run can't leave it installed for later
  suites.

Example: `artifacts/api-server/src/__tests__/migration0139.factGags.test.ts`.
