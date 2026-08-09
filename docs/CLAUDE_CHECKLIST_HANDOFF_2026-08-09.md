# Checklist Investigation Handoff for Claude

**Date:** 2026-08-09  
**Purpose:** Handoff of the post-merge `docs/PR*_TEST_RUN.md` investigation.  
**Current stopping point:** PR293, due to a live-data invariant failure. PR308 has not been run.

> **Claude's review outcome (2026-08-09): the PR293 stop is resolved — PR308 is
> unblocked.** The dangling reference is not a defect and needs no repair. See
> [Claude's review outcome](#claudes-review-outcome-2026-08-09) at the end of
> this document.

## Executive summary

This investigation was performed in the current Lite environment. No Economy upgrade
or agent handoff was required for the technical work.

The checklist run progressed successfully through PR288. PR293's migration and
schema checks passed, but its live quarantine backfill invariant found one dangling
historical reference:

```text
ncmec_reports.id = 2
request_metadata.quarantineId = 4
quarantined_memes.id = 4 does not exist
```

No production row was deleted, fabricated, or rewritten. The next investigator
should determine the correct forward-only disposition with the data owner before
continuing to PR308.

## Workspace state and uncommitted changes

At handoff, the expected feature/test changes are uncommitted:

```text
M artifacts/overhype-me/e2e/adminBillingSync.spec.ts
M artifacts/overhype-me/src/pages/admin/billing.tsx
M lib/db/src/schema/facts.ts
M lib/db/migrations/meta/_journal.json
M lib/db/scripts/check-migration-snapshots.ts
?? lib/db/migrations/0098_fact_lifecycle_check_repair.sql
```

The changes are intentional:

1. `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`
   - Reads the `csrf_token` cookie after dev-admin login.
   - Sends it as `x-csrf-token` on both direct simulation POSTs.
2. `artifacts/overhype-me/src/pages/admin/billing.tsx`
   - Displays resources that have not started yet as `pending` while a sequential
     sync is in progress.
   - Keeps the persisted API status vocabulary unchanged.
3. PR242 repair:
   - `lib/db/src/schema/facts.ts` now declares the
     `facts_active_requires_concept` CHECK in the Drizzle schema.
   - `lib/db/migrations/0098_fact_lifecycle_check_repair.sql` restores the
     constraint forward-only if it is absent.
   - Journal and snapshot-exemption bookkeeping includes migration 0098.

Do not revert these changes as part of investigating PR293.

## Checklist results

### PR224 — passed

- Snapshot validation passed.
- Snapshot chain passed.
- Documentation accuracy passed.
- Migration 0087 column exists as nullable `varchar(64)`.
- Migration 0088 style text is under 180 characters; `none` remains empty.
- Migration tracker reported all migrations up to date.
- Earlier targeted run passed 184 tests with 0 failures.
- The checklist explicitly said targeted CI tests did not need to be rerun.
- The attempted full PR224 sharded suite was blocked by the environment during
  the pretest schema-push chain; targeted tests passed.

### PR228 — passed

- Snapshot and docs gates passed.
- Migration 0089 table exists with expected columns, foreign keys, and indexes.
- `pending_reviews.approved_fact_id` exists.
- Migration rerun skipped all migrations.

### PR229 — passed

- Snapshot and docs gates passed.
- Migration 0090 is tracked as applied.
- `fact_visual_concepts_system` contains the required bubbles contract.
- Codegen export is registered.

### PR234 — passed

- Snapshot and docs gates passed.
- No migration or live-database work was required.

### PR242 — repaired, then passed

Initial live checks found:

- Migrations 0091 and 0092 were recorded as applied.
- `pending_reviews.parent_fact_id` existed with the expected FK.
- `facts.is_active` defaulted to false.
- The live database was missing `facts_active_requires_concept`.
- The initial direct invariant check reported active facts without a valid Visual
  Concept. A later exact checklist query returned zero; the data backfill was
  present, while the CHECK constraint was definitely absent.

Repair performed:

- Added the matching `check()` declaration to `lib/db/src/schema/facts.ts`.
- Added forward-only migration 0098:
  `lib/db/migrations/0098_fact_lifecycle_check_repair.sql`.
- Ran the migration successfully:

```text
[migrate] Applying 0098_fact_lifecycle_check_repair
[migrate] Done: 1 applied, 98 already up-to-date
```

- DB typecheck passed.
- Constraint was verified as present and validated.
- Exact active-without-concept query returned `0`.
- Sentinel Visual Concept count was `42`.
- A bad active-fact insert was rejected by
  `facts_active_requires_concept`; the transaction was rolled back and the probe
  row count remained `0`.

Important lesson: raw-SQL constraints need a matching schema declaration. Otherwise
schema synchronization can remove a constraint after the migration tracker has
already recorded the hand-authored migration as applied.

### PR256 — passed

- Snapshot and docs gates passed.
- Migration 0093 was applied and tracked.
- `facts.ai_meme_backfill_status` exists as nullable `varchar(16)` with no default.
- All 51 existing facts had `NULL` status.
- No processed `fact_ai_meme_backfill` jobs existed to inspect.

### PR276 — passed after fixing two test/UI defects

The exact e2e command was:

```bash
E2E_BASE_URL="https://${REPLIT_DEV_DOMAIN}" \
pnpm --filter @workspace/overhype-me run e2e -- adminBillingSync
```

Final result:

```text
1 passed (28.0s)
```

Initial failure:

```text
POST /api/admin/stripe/sync/_test/simulate
Expected: 200
Received: 403
```

Root cause: the test used a valid dev-admin session cookie but direct
`context.request.post()` does not automatically echo the CSRF cookie as the
required `x-csrf-token` header. The real UI POST succeeded, confirming the
session itself was valid.

Second failure after the CSRF fix:

```text
Prices row should be in "pending" state right now
Expected: "pending"
Received: "never synced — use Full sync"
```

Root cause: the sequential simulation deletes prior status rows. The API
legitimately reports a not-yet-started resource as `idle` because it has no
persisted row, while the UI rendered every `idle` resource as historically
never synced. The UI now derives a presentation-only `pending` state when
`syncStatus.inProgress` is true.

### PR287 — passed, with one checklist wording issue

Live migration checks passed:

- `membership_entitlements`, `entitlement_source_disputes`, and
  `membership_leases` exist.
- Legacy `subscriptions` and `lifetime_entitlements` tables are gone.
- `users.membership_valid_until` is nullable `timestamp with time zone`.
- Both membership sequences exist.
- Both expected triggers exist.
- No duplicate constraints exist.
- There were `0` entitlement rows, so the rollback-only identity-guard probe was
  not run; synthetic billing data was not created.

Config values at the start:

```text
grace_sweep_alert_after_seconds=21600
grace_sweep_interval_seconds=3600
lease_ttl_seconds=90
lease_waiter_timeout_seconds=5
```

Results:

- Valid `lease_ttl_seconds: 90 -> 120 -> 90`: 200, 200; restored.
- `lease_ttl_seconds=5`: 400, with `Value must be at least 83`.
- `lease_waiter_timeout_seconds=100`: 400.
- `grace_sweep_alert_after_seconds=3599`: 400.
- Original alert value `21600` was restored successfully.

The checklist says the alert probe should use “at or below” the interval. The
implementation correctly allows equality because the rule is “at least
grace_sweep_interval_seconds”; only a value below the interval is invalid. A
probe using equality (`3600`) returned 200 and was restored to `21600`.

### PR288 — passed

Repo gates passed. Live checks passed:

- `worker_lane_heartbeats` exists with the expected shape.
- Primary key `(instance_id, lane)` exists.
- `last_scheduled_at` is non-null `timestamptz` with default `now()`.
- `last_tick_completed_at` is nullable.
- `in_flight_count` defaults to `0`.
- `worker_lane_heartbeats_last_scheduled_idx` exists.
- `instance_heartbeat_ttl_minutes=15`, integer, min `1`, max `1440`.
- Five lanes had fresh heartbeats:
  `fast`, `render`, `bulk`, `pexels`, `ai_meme_backfill`.
- There were two live worker instance IDs, each reporting all five lanes.
- `GET /api/health/queues` returned 200 with exactly:

```json
{"ok":true,"ts":"...","laneCount":5,"stalledLaneCount":0}
```

- `GET /api/admin/queue-health` returned all 12 registered queues.
- `GET /api/admin/queue-health/jobs?limit=100000` returned `limit: 100`.
- Neither admin response exposed `activeAlerts` or `unacknowledgedAlerts`.
- No `fact_ai_meme_backfill` rows existed, so skipped/abandoned derived-status
  examples could not be checked without inventing data.

### PR293 — stopped on significant live-data failure

Repository gates passed:

```text
validate-snapshots: passed
check-snapshots: passed
docs-accuracy: 140 files, all relative links resolve
```

Migration 0097 schema checks passed, including:

- New `ncmec_safety_audit_log` table and expected columns.
- New NCMEC report columns.
- New `quarantined_memes` columns.
- Submission-status CHECK with the six expected values.
- Content-origin CHECK with the five expected values.
- `quarantine_id` FK with `ON DELETE SET NULL`.
- `ncmec_reports_link_quarantine_trg`.
- Partial unique index `UQ_ncmec_reports_quarantine`.
- `IDX_ncmec_nonfinal`.
- `IDX_ncmec_failed_unalerted`.
- Append-only audit triggers with `tgenabled = 'A'`.
- Append-only function body intact.
- All eight seeded NCMEC config rows with expected values/bounds.

The live backfill query returned:

```text
missing | malformed | dangling | linkable_but_unlinked
--------+-----------+----------+-----------------------
0       | 0         | 1        | 0
```

Exact offending row:

```text
report_id | quarantine_id | request_metadata                         | submission_status | created_at
----------+---------------+-------------------------------------------+-------------------+-------------------------
2         | NULL          | {"quarantineId": 4, ...}                  | pending           | 2026-05-08 05:58:19+00
```

The referenced quarantine row is absent:

```text
SELECT id FROM quarantined_memes WHERE id = 4;
-- 0 rows
```

The row appears to be a historical/test fixture (`request_metadata` also
contained `"test": "phase1-test-plan"`), but that must be confirmed before
deciding how to repair it.

Do not:

- Delete `ncmec_reports.id = 2` casually.
- Fabricate `quarantined_memes.id = 4` without confirming the original content and
  audit implications.
- Rewrite migration 0097.
- Relax or remove the backfill invariant merely to make the checklist green.

Recommended investigation:

1. Inspect the full historical provenance of `ncmec_reports.id = 2`, including
   audit rows, request metadata, and any related application/test fixture.
2. Determine whether `quarantineId=4` was an intentional disposable fixture,
   a deleted real quarantine record, or a migration-created orphan.
3. Choose a forward-only disposition preserving the report/audit history.
4. If the reference is intentionally historical and unrepairable, document the
   approved exception in the appropriate durable project decision record rather
   than silently changing the row.
5. If repair is approved, add a safe forward migration and rerun the PR293
   backfill query.
6. Only after PR293 is resolved, continue with PR308.

Relevant source:

- `lib/db/migrations/0097_ncmec_submission.sql`
- `lib/db/src/schema/moderation.ts`
- `docs/PR293_NCMEC_CYBERTIPLINE_TEST_RUN.md`

The migration itself explicitly warns about malformed/dangling quarantine IDs
and says they must be dispositioned by the pre-activation backlog audit. It also
contains a guard against silently choosing an authoritative report when duplicate
claims exist. Read that migration before writing any repair.

## PR308 status

Not run. It should remain blocked until the PR293 live-data issue is understood or
explicitly dispositioned.

## Commands and environment notes

The application uses managed workflows:

- `artifacts/overhype-me: web`
- `artifacts/api-server: API Server`
- `artifacts/mockup-sandbox: Component Preview Server`

The API server was healthy during the successful checklist checks and was serving
on port 8080. The web Vite server was serving on port 26169. The current workflow
status may differ after this handoff; verify logs before relying on it.

### Later workflow-status note

After the checklist work completed, the three managed artifact workflows reported
`FAILED`. Their logs show supervisor lock contention, not an application startup
or migration failure:

```text
another supervisor for this label is already holding
/tmp/dev-supervisor-overhype-me.lock
/tmp/dev-supervisor-api-server.lock
/tmp/dev-supervisor-mockup-sandbox.lock
```

The API workflow's predev migration still completed successfully immediately
before the duplicate-supervisor refusal:

```text
[migrate] Done: 0 applied, 99 already up-to-date (99 total in journal).
```

If Claude needs live previews, restart the existing managed workflows after
clearing or allowing the stale supervisor processes/locks to resolve. Do not
interpret these later workflow statuses as evidence that PR293's migration
checks failed.

For authenticated live admin probes, the reliable pattern is:

1. POST `/api/auth/dev-admin-login`.
2. Capture the `csrf_token` cookie.
3. Send it as `x-csrf-token` for POST/PATCH requests.

No secret values are included in this handoff.

## Claude's review outcome (2026-08-09)

### PR293 — resolved, no repair needed, PR308 unblocked

`dangling = 1` is **not** an invariant failure. Flagging it was correct — the
checklist asked for that — but treating it as a stop condition, and blocking
PR308 behind it, was not.

Three independent reasons, none of which require inspecting the live row
further:

1. **Migration 0097 treats `dangling` as a warning by design.** Its
   classification block raises an exception for `conflicting` only; `malformed`
   and `dangling` fall through to `RAISE WARNING` and are deliberately left
   `NULL`. The migration is behaving exactly as written.
2. **A dangling id cannot cause the harm the checklist named.** The duplicate-report
   risk comes from the orphan reconciler's pass over quarantine rows that no
   report references. `quarantined_memes.id = 4` does not exist, so that pass has
   nothing to find and no second report it can create. The risk is specific to
   `linkable_but_unlinked`, which was `0`. (The reconciler is also phase 5 — not
   built yet.)
3. **The disposition is already settled and is not per-row.** Per David's
   2026-08-07 decision, recorded in the header of
   `artifacts/api-server/src/lib/moderation/ncmecWorker.ts`: the platform has
   never been live, so every `ncmec_reports` / `quarantined_memes` row today is a
   test artifact rather than evidence, and the activation runbook deletes all of
   them before the filing switch is thrown. The `"test": "phase1-test-plan"`
   marker on `ncmec_reports.id = 2` is consistent with that. There is no backlog
   audit to defer this to — that ceremony was retired by the same decision.

So: **no forward repair migration, no row deletion, no decision record.** The
row gets cleaned up with everything else at activation.

The checklist was the thing at fault, and it has been corrected in
`docs/PR293_NCMEC_CYBERTIPLINE_TEST_RUN.md`: it was written before the
2026-08-07 decision, still referred to the retired backlog audit, and lumped
`dangling` in with `linkable_but_unlinked` under one duplicate-report rationale
that only applies to the latter. `malformed`/`dangling` are now explicitly
"record and continue".

### PR287 — the checklist wording issue is confirmed and fixed

The observation was right and the probe row was wrong, not just its prose. The
validator's rule is "at least `grace_sweep_interval_seconds`", so a value
*equal* to the interval is valid and returns 200. The checklist now asks for
`interval − 1` and says so.

### PR242 repair — accepted

Migration 0098's constraint definition is character-identical to 0092's, the
`check()` declaration in `lib/db/src/schema/facts.ts` matches it, and CI on
`main` is green over all of it (snapshot chain, docs accuracy, codegen drift).
The snapshot exemption is consistent with the 34 hand-authored migrations since
0063 that carry no snapshot.

The lesson recorded above — a raw-SQL constraint needs a matching schema
declaration or a later schema sync can silently drop it — is correct and worth
promoting into `docs/ai-context/known-failure-patterns.md`.

### PR276 fixes — accepted, with two notes

Both root causes are right and the fixes are in the correct layer (the test was
wrong about CSRF; the UI was wrong to render "never synced" for a resource that
simply hadn't started yet). Two things left as-is, neither blocking:

- A resource that *has* synced before but hasn't started this run now renders a
  bare `pending`, dropping the `· last synced <when>` it used to show.
- `data-status` now emits `pending`, which is not a value the API's
  `SyncResourceStatus` union can hold. Only the e2e spec reads that attribute, so
  nothing breaks — but the DOM attribute is now presentation state, not the API
  vocabulary it used to mirror.

### Process note

The three commits described above as "uncommitted" were committed and pushed
**directly to `main`** (`22a18d2`, `a71f365`, `35b5fa2`) — including a database
migration, a schema change, and a production UI change — with no pull request and
no Codex review. CI on `main` passed. Flagged to David separately; it is a
workflow question, not a defect in the work itself.