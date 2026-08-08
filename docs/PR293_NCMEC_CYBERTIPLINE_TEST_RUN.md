# PR293 — NCMEC CyberTipline reporting, phases 1-2 of 8 · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no DATABASE_URL / test-DB env
is set here, **except in the one step below that is explicitly called out as
an exception** (`@workspace/db`'s own suite has no automatic isolation —
see that step for why).

Pre-merge gates (install, typecheck, codegen drift) are assumed green;
spot-check only if something below fails. Note: `artifacts/api-server`
gained a new direct dependency, `fast-xml-parser` (pinned `5.10.1`) — if
`pnpm install --frozen-lockfile` fails, that's the first thing to check.

## Repo-health gates (post-merge state — run always)
- `pnpm --filter @workspace/db validate-snapshots` — expected: passes
  (matches CI's `build.yml`)
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entry this PR added: `0097_ncmec_submission`
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: none

## Targeted tests (run always)
Run from the **repo root** (the script itself `cd`s into
`artifacts/api-server`, so the file arguments below are relative to that
package, not the root — if invoking from inside `artifacts/api-server`
instead, use `bash scripts/run-test.sh <same file args>`):
```
bash artifacts/api-server/scripts/run-test.sh \
  src/__tests__/migrations.0097.test.ts \
  src/__tests__/moderation.ncmecClient.test.ts \
  src/__tests__/routes.admin.test.ts
```
Expected: **0 fail**. `migrations.0097.test.ts` covers the append-only
audit-ledger triggers, the reserved-config-key lockstep between the SQL
constraint/seed list and the TypeScript constants, and the migration's own
warning-on-unenforced-boundary behavior. `moderation.ncmecClient.test.ts`
covers the ISPWS HTTP client and XML builders against committed fixtures
with zero network access. `routes.admin.test.ts` includes the reserved-key
403 refusal on `PATCH /admin/config/:key`.

Also run `lib/db`'s own suite (see "Full sharded suite" below for why this
is now wired into CI as a separate step, not folded into api-server's
shards). **Unlike every other test command in this doc, this package's
`test` script (`node --import tsx/esm --test 'src/**/*.test.ts'`) has no
built-in production guard or test-DB redirection at all** — it runs against
whatever `DATABASE_URL` is already set to. `ncmecAuditBoundaryStatus.test.ts`
creates login roles and schemas and mutates role grants (including chains to
`overhype_audit_maintenance`), so running it against Replit's live database
would mutate the live cluster.

**Use a database separate from the one the API-server suite uses**
(`heliumdb_test`), not that same one — mirroring exactly what this PR's own
new CI step does on GitHub Actions (a dedicated `overhype_db_test`, never
`overhype_test`, precisely so the two suites' schema-management sequences
(this suite's raw `push-force` + `migrate`, versus api-server's `pretest`
running the same pair in a different order) can never race or drop each
other's unshadowed objects — see
[`raw-sql-migration-needs-schema-shadow.md`](../.agents/memory/raw-sql-migration-needs-schema-shadow.md)
for why that's a real, previously-hit failure mode, not a theoretical one).
Create or reuse a dedicated isolated database for this suite, apply the
current schema to it fresh, then run the suite against it:
```
DATABASE_URL=<Replit's dedicated lib/db test database, separate from
  heliumdb_test, NOT the live one> \
  pnpm --filter @workspace/db push-force
DATABASE_URL=<same dedicated database> \
  pnpm --filter @workspace/db run migrate
DATABASE_URL=<same dedicated database> \
  pnpm --filter @workspace/db run test
```
Expected: **0 fail**. Asserts `canEffectivelyAssumeRole()`'s reachability
union (`usage` OR `set` OR a transitive admin-option chain) against a live
Postgres instance, including the case that motivated it — a role that can
reach a target only through an inherited `ADMIN OPTION`, which neither
`'usage'` nor `'set'` alone would report as reachable.

Proof tests to note: the constraint/seed/TypeScript lockstep assertion in
`migrations.0097.test.ts` is a tripwire — it fails CI the moment the CHECK
constraint's action vocabulary, the seed list, or `NCMEC_AUDIT_ACTIONS`
drift out of sync with each other, rather than letting a silent mismatch
ship.

## Full sharded suite — shared infra touched: **yes**
This PR adds ~460 lines to `lib/db/src/index.ts` (`canEffectivelyAssumeRole()`,
`ncmecAuditBoundaryStatus()`, and supporting privilege-check helpers) — core,
widely-imported `@workspace/db` code, not a leaf module — and a new CI step
(`overhype_db_test`, a database separate from `overhype_test`) that runs
`@workspace/db`'s own suite for the first time. Run:

```
pnpm --filter @workspace/api-server test
```
(Stop the `artifacts/api-server: API Server` workflow first to free
test-DB connections.)

Expected: **0 fail**. Known environmental failures: none currently
tracked for this PR's own changes.

## Manual DB / behavior checks (run always)

1. **Migration `0097` applied — full schema check.**

   `ncmec_safety_audit_log` (all 10 columns):

   | Column | Type | Nullable | Default |
   |---|---|---|---|
   | `id` | `bigserial` | NOT NULL | sequence |
   | `report_id` | `bigint` | nullable | — |
   | `actor_user_id` | `varchar` | nullable | — |
   | `actor_label` | `text` | NOT NULL | — |
   | `action` | `varchar(40)` | NOT NULL | — |
   | `reason` | `text` | nullable | — |
   | `before_state` | `jsonb` | nullable | — |
   | `after_state` | `jsonb` | nullable | — |
   | `attempt_id` | `uuid` | nullable | — |
   | `created_at` | `timestamptz` | NOT NULL | `now()` |

   `ncmec_reports` carries all 24 new columns this migration adds:
   `finished_at`, `finish_started_at`, `attempt_count` (`integer NOT NULL
   DEFAULT 0`), `last_error`, `last_error_code`, `submission_environment`
   (`varchar(16)`), `uploaded_files` (`jsonb`), `retracted_at`,
   `submission_lease_owner`, `submission_lease_until`, `manually_filed_at`,
   `test_submitted_at`, `test_submission_started_at`, `test_report_id`
   (`varchar(64)`), `quarantine_id` (`bigint`), `failed_at`,
   `last_attempt_failed_at`, `alert_notified_at`, `content_origin`
   (`varchar(16)`), `reporter_snapshot` (`jsonb`), `backlog_audited_at`,
   `backlog_audit_note`, `identity_omission_approved_at`,
   `manual_report_id` (`varchar(64)`) — every one nullable or defaulted, no
   exceptions.

   `quarantined_memes` carries 4 new columns: `content_origin`
   (`varchar(16)`), `report_intent` (`boolean`), `reporter_snapshot`
   (`jsonb`), `request_metadata` (`jsonb`).

   `ncmec_reports` carries the `ncmec_reports_submission_status_check`
   constraint, the `ncmec_reports_content_origin_check` constraint, the
   `ncmec_reports_quarantine_id_fk` foreign key (`quarantine_id` →
   `quarantined_memes.id`), the `ncmec_reports_link_quarantine_trg`
   trigger, the `UQ_ncmec_reports_quarantine` unique index (unique on
   `quarantine_id` WHERE `quarantine_id IS NOT NULL` — this is the
   one-report-per-quarantine-hit guarantee; a partial migration missing
   just this index would pass every other check here while leaving that
   invariant unenforced), and the `IDX_ncmec_nonfinal` /
   `IDX_ncmec_failed_unalerted` indexes.

   `quarantined_memes` carries the `quarantined_memes_content_origin_check`
   constraint.

   `ncmec_safety_audit_log` carries the `ncmec_safety_audit_log_action_check`
   constraint (the closed action vocabulary), the
   `ncmec_safety_audit_log_report_id_fk` foreign key (`report_id` →
   `ncmec_reports.id`), and the `IDX_ncmec_audit_report_created` /
   `IDX_ncmec_audit_created` indexes.

   `admin_config` has exactly these 8 new rows (key / value / data_type /
   min / max):

   | Key | Seeded value | Type | Min | Max |
   |---|---|---|---|---|
   | `ncmec_submission_enabled` | `false` | boolean | — | — |
   | `ncmec_ispws_environment` | `test` | text | — | — |
   | `ncmec_report_classifier_hits` | `false` | boolean | — | — |
   | `ncmec_backlog_audit_cutoff` | `` (empty) | text | — | — |
   | `ncmec_backlog_audit_completed_at` | `` (empty) | text | — | — |
   | `ncmec_safety_alert_email` | `` (empty) | text | — | — |
   | `async_job_ncmec_submit_max_attempts` | `8` | integer | `1` | `20` |
   | `async_job_ncmec_submit_retry_delay_4_ms` | `86400000` | integer | `60000` | `604800000` |

2. **Re-running migration `0097` — describe what actually happens, not an
   assumed no-op.** A normal second `pnpm --filter @workspace/db run
   migrate` does **not** re-execute this file's SQL at all — the runner
   tracks applied migrations by content hash and skips anything already
   recorded, so this only confirms the *tracking* is working, not that the
   SQL is idempotent on its own. Confirm: the second run reports the
   migration as skipped (not applied, not erroring) and no schema/data
   changes result.

   If you want to actually exercise the SQL's own idempotency (not required
   for this checklist, but useful context): the trigger and CHECK-constraint
   blocks are `DROP ... IF EXISTS` + unconditional recreate (safe to
   re-apply, but a real DDL operation each time, not a true no-op), the
   table/index/column additions are all `IF NOT EXISTS`, and the
   `admin_config` seed is `ON CONFLICT ("key") DO NOTHING` — but forcing a
   second raw execution requires manually clearing the migration's tracked
   hash first, which isn't part of this routine checklist.

3. **The append-only guarantee — probe inside a transaction that always
   rolls back, never against a real row.** Never target an existing row
   directly: if the guard is broken (the exact failure this check exists to
   catch), an `UPDATE`/`DELETE` against a real row would rewrite or destroy
   a genuine audit record with no way back. And even a fresh sentinel row
   is unsafe outside a transaction: in the *passing* case the guard is
   supposed to block `DELETE` too, so a plain (non-transactional) test
   insert would leave a fabricated row nothing can ever remove via ordinary
   access.

   Run this as one transaction that always ends in `ROLLBACK`, so nothing
   persists — as the application role, not a superuser:
   ```sql
   BEGIN;
   INSERT INTO ncmec_safety_audit_log (actor_label, action, reason)
     VALUES ('test-run-sentinel', 'reopen', 'append-only probe, always rolled back')
     RETURNING id \gset
   SAVEPOINT before_update;
   UPDATE ncmec_safety_audit_log SET reason = 'x' WHERE id = :id;  -- expect an error
   ROLLBACK TO SAVEPOINT before_update;
   SAVEPOINT before_delete;
   DELETE FROM ncmec_safety_audit_log WHERE id = :id;              -- expect an error
   ROLLBACK TO SAVEPOINT before_delete;
   ROLLBACK;  -- always — discards the sentinel insert too, real row or not
   ```

   Two valid outcomes for the `UPDATE`/`DELETE` attempts, depending on
   whether the audit-ledger hardening runbook has been run:
   - **If [`ncmec-audit-ledger-hardening.md`](engineering/ncmec-audit-ledger-hardening.md)'s
     runbook has NOT been run yet** (the default, out-of-the-box state):
     both statements succeed at the privilege level and then raise
     `ncmec_safety_audit_log is append-only` from the trigger.
   - **If the runbook HAS been run**: the application role only holds
     `SELECT, INSERT` (per the runbook's `GRANT` step), so both statements
     fail with a plain Postgres `permission denied for table
     ncmec_safety_audit_log` — the trigger never gets a chance to fire, and
     that's *more* locked down, not a regression.

   Either error is a pass. What would be a real failure: either statement
   succeeding with no error at all. The final `ROLLBACK` runs regardless of
   which outcome occurred, so the ledger ends this check exactly as it
   started, in both the passing and (hypothetically) failing case.

4. **The reserved-config-key guard rejects filing-capable keys.** As an
   admin, `PATCH /api/admin/config/ncmec_submission_enabled` (or any of the
   other four reserved keys — see below) with any body — expect **403**
   with the reserved-key refusal message, not the normal validation
   response. `PATCH /api/admin/config/ncmec_safety_alert_email` with a
   valid string, by contrast, should succeed normally — it is deliberately
   not reserved (see the note below). **Immediately after this check,
   record whatever the pre-test value of `ncmec_safety_alert_email` was and
   restore it** (see the cleanup note below) — this is a real write against
   a persistent, live-effect config row.

## Cleanup — restore any config rows this checklist wrote

Step 4 above successfully writes to `ncmec_safety_alert_email` (a real,
persistent `admin_config` row that will govern real alert routing once
production filing exists). Before finishing this checklist: note that row's
value **before** running step 4, and set it back to that value (or back to
empty, if it was empty) afterward. Do the same for any of the other two
unreserved keys (`async_job_ncmec_submit_max_attempts`,
`async_job_ncmec_submit_retry_delay_4_ms`) if you additionally exercised
them while testing. The five reserved keys need no cleanup — every attempt
against them is refused before any write happens.

## What's deliberately NOT shipped
- No caller for the ISPWS client/XML builders yet — nothing can file a
  report with NCMEC. `ncmec_submission_enabled` and
  `ncmec_report_classifier_hits` are seeded `false`, and — as of a later
  phase already on `main` (#349) — `ncmec_backlog_audit_cutoff` and
  `ncmec_backlog_audit_completed_at` are vestigial for filing-eligibility
  purposes specifically (`isSubmittable()` no longer reads them, pending a
  cleanup migration); they are still real seeded config rows and the
  generic route still refuses to write them, which is what this checklist
  tests.
- No guarded write path for the 5 reserved config keys — they are
  unwritable through any route right now (the generic `PATCH
  /admin/config/:key` refuses them; the guarded `/admin/safety/config`
  endpoint that will own them ships in a later phase). This is intentional,
  not a gap: the master switch and its siblings should be unreachable by
  any write path until the worker that would act on them exists.
- No dedicated `/admin/safety` admin page. The 8 seeded config keys are
  visible and (for the 3 unreserved ones) editable through the existing
  generic `/admin/config` cards today.
- `ncmec_safety_alert_email`, `async_job_ncmec_submit_max_attempts`, and
  `async_job_ncmec_submit_retry_delay_4_ms` are writable with only generic
  type/min-max validation — the cross-key and live-state checks that make
  them fully safe (e.g. refusing to empty the alert recipient while
  production filing is live) are deferred to the same later phase as the
  guarded write path, since they only matter once production filing can
  actually happen.

## Delete me
Transient — delete once the checklist has been run. The `_UAT.md` sibling
is the durable half.
