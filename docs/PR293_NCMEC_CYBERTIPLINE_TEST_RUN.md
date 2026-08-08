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
  src/__tests__/moderation.ncmecClient.test.ts \
  src/__tests__/routes.admin.test.ts
```
Expected: **0 fail**. `moderation.ncmecClient.test.ts` covers the ISPWS HTTP
client and XML builders against committed fixtures with zero network
access. `routes.admin.test.ts` includes the reserved-key 403 refusal on
`PATCH /admin/config/:key`.

**`migrations.0097.test.ts` does NOT run through `run-test.sh` above —
it needs the same disposable cluster as the `lib/db` suite below, for the
same reason.** `run-test.sh`'s isolation is schema-level only (a
`heliumdb_test` *schema* inside whatever database `DATABASE_URL` already
points to, via `search_path` — not a separate database, and not a separate
cluster). This file unconditionally creates roles — including
`overhype_audit_maintenance` outside a rolled-back transaction, in more than
one test case — so running it through `run-test.sh` still creates/drops
roles in the real cluster's one shared role namespace regardless of which
schema the tables land in. On a workspace where the audit-ledger hardening
runbook has already been run, `overhype_audit_maintenance` already exists
as a real role, and this file's unconditional `CREATE ROLE
overhype_audit_maintenance` fails outright with `role already exists` —
contradicting an expected "0 fail" for the wrong reason (a real role
collision, not a real test failure). Run it directly, after setting up the
disposable cluster below (share that same cluster and `DATABASE_URL`; no
need for a second one):
```
node --import tsx/esm --test src/__tests__/migrations.0097.test.ts
```
(from `artifacts/api-server`, with the disposable cluster's `DATABASE_URL`
still exported from the steps below). Expected: **0 fail**. Covers the
append-only audit-ledger triggers, the reserved-config-key lockstep between
the SQL constraint/seed list and the TypeScript constants, and the
migration's own warning-on-unenforced-boundary behavior.

Also run `lib/db`'s own suite (see "Full sharded suite" below for why this
is now wired into CI as a separate step, not folded into api-server's
shards). **Unlike every other test command in this doc, this package's
`test` script (`node --import tsx/esm --test 'src/**/*.test.ts'`) has no
built-in production guard or test-DB redirection at all** — it runs against
whatever `DATABASE_URL` is already set to. `ncmecAuditBoundaryStatus.test.ts`
creates login roles and mutates role grants (including chains to
`overhype_audit_maintenance`), so running it against Replit's live database
would mutate the live cluster.

**This needs a genuinely separate PostgreSQL cluster/service, not merely a
separate database.** Postgres roles are cluster-scoped, not database-scoped:
pointing this suite at another database on the *same* cluster as whatever
`DATABASE_URL` already points to (live or otherwise) still creates, grants,
and drops roles in that cluster's one shared, global role namespace — and a
suite that aborts partway can leave roles or grants behind. Use a disposable
Postgres instance — a cluster separate from wherever `DATABASE_URL` normally
points (e.g. a second Replit Postgres service, or a throwaway container) —
not just another database or schema name inside the existing one. CI's own
`overhype_db_test` separation (mirrored below) is a *database* separation
because CI's runner is itself a disposable container-per-job, so the
cluster-scoping gap never bites there; a long-lived Replit workspace does
hit it, so mirror the isolated-*cluster* intent here, not just the
database-name mechanics — this is also what keeps the two suites'
schema-management sequences (this suite's raw `push-force` + `migrate`,
versus api-server's `pretest` running the same pair in a different order)
from racing or dropping each other's unshadowed objects — see
[`raw-sql-migration-needs-schema-shadow.md`](../.agents/memory/raw-sql-migration-needs-schema-shadow.md)
for why that's a real, previously-hit failure mode, not a theoretical one.

**Export the disposable cluster's URL once, then run every command against
it** — do not repeat `DATABASE_URL=<...>` as a prefix on each command line
while also referencing `"$DATABASE_URL"` inside that same line: bash expands
`"$DATABASE_URL"` using whatever is *already* exported before applying a
command-local prefix assignment, so a line like
`DATABASE_URL=<new> psql "$DATABASE_URL" ...` silently runs against the
**old** (possibly live) value, not the new one:
```
export DATABASE_URL=<disposable Postgres instance's database — a separate
  cluster/service, NOT another database or schema inside the existing one>
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector;'
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/db run test
```
(The `CREATE EXTENSION` step comes first because the schema has vector
columns and a fresh database won't have the extension yet — the same step
CI's own `overhype_db_test` preparation runs before its `push-force`.)

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
   | `id` | `bigint` (`bigserial` is sugar — Postgres stores and reports it as `bigint`; there is no queryable `bigserial` type) | NOT NULL | `nextval('ncmec_safety_audit_log_id_seq'::regclass)` |
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
   constraint (**verify the definition, not just the name** — a drifted
   same-named constraint would pass a name-only check):
   `CHECK (submission_status IN ('pending','in_progress','submitted','filed_manually','failed','not_reportable'))`
   (exactly these 6 values); the `ncmec_reports_content_origin_check`
   constraint: `CHECK (content_origin IS NULL OR content_origin IN ('generated','user_upload','stock','template','identity'))`
   (exactly these 5 values, nullable); the `ncmec_reports_quarantine_id_fk`
   foreign key (`quarantine_id` → `quarantined_memes.id`, **`ON DELETE SET
   NULL`**, `ON UPDATE NO ACTION`); the `ncmec_reports_link_quarantine_trg`
   trigger; the `UQ_ncmec_reports_quarantine` unique index (unique on
   `quarantine_id` WHERE `quarantine_id IS NOT NULL` — this is the
   one-report-per-quarantine-hit guarantee; a partial migration missing
   just this index would pass every other check here while leaving that
   invariant unenforced); and the `IDX_ncmec_nonfinal` /
   `IDX_ncmec_failed_unalerted` indexes.

   `quarantined_memes` carries the `quarantined_memes_content_origin_check`
   constraint — same definition as `ncmec_reports`' above (5 values,
   nullable).

   `ncmec_safety_audit_log` carries the `ncmec_safety_audit_log_action_check`
   constraint: `CHECK (action IN ('retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write'))`
   (the closed action vocabulary — exactly these 9 values); the
   `ncmec_safety_audit_log_report_id_fk` foreign key (`report_id` →
   `ncmec_reports.id`, **`ON DELETE RESTRICT`** — deliberately not `SET
   NULL`, so the ledger can never lose which report an entry was about —
   `ON UPDATE NO ACTION`); and the `IDX_ncmec_audit_report_created` /
   `IDX_ncmec_audit_created` indexes — **and both append-only triggers**,
   which the behavioral probe below only exercises indirectly and a
   name-only check can miss in a way that leaves the ledger destructible.
   Verify both, not just their names:

   | Trigger | Fires on | Enabled | Function |
   |---|---|---|---|
   | `ncmec_safety_audit_log_no_mutate` | `BEFORE UPDATE OR DELETE`, `FOR EACH ROW` | `ALWAYS` (`tgenabled = 'A'`, not the default `'O'` — `'O'`-only would let a session that sets `session_replication_role = replica` bypass it) | `ncmec_safety_audit_log_append_only()` |
   | `ncmec_safety_audit_log_no_truncate` | `BEFORE TRUNCATE`, `FOR EACH STATEMENT` | `ALWAYS` (same reason) | `ncmec_safety_audit_log_append_only()` |

   A deployment missing only `_no_truncate` passes every check above and
   the transactional `UPDATE`/`DELETE` probe in step 4 below, while an
   authorized `TRUNCATE` could still erase the entire ledger — this is the
   one failure mode step 4 cannot catch on its own, which is why both
   triggers need verifying here, not just probing there.

   `admin_config` has exactly these 8 new rows (key / type / min / max).
   **The 5 reserved keys' values are exact and required** (nothing writes
   to them outside this migration's own seed, so any drift means a partial
   or corrupted migration). **The 3 unreserved keys are legitimately
   editable, and the seed's `ON CONFLICT ("key") DO NOTHING` exists
   specifically to preserve an operator's later change** — verify their
   row exists with the right type/bounds/provenance, but treat their
   *current* value as live state to leave alone, not a required match
   against the seed:

   | Key | Seeded value | Type | Min | Max | Value check |
   |---|---|---|---|---|---|
   | `ncmec_submission_enabled` | `false` | boolean | — | — | must equal seed |
   | `ncmec_ispws_environment` | `test` | text | — | — | must equal seed |
   | `ncmec_report_classifier_hits` | `false` | boolean | — | — | must equal seed |
   | `ncmec_backlog_audit_cutoff` | `` (empty) | text | — | — | must equal seed |
   | `ncmec_backlog_audit_completed_at` | `` (empty) | text | — | — | must equal seed |
   | `ncmec_safety_alert_email` | `` (empty) | text | — | — | row/type/bounds only — current value may legitimately differ |
   | `async_job_ncmec_submit_max_attempts` | `8` | integer | `1` | `20` | row/type/bounds only — current value may legitimately differ |
   | `async_job_ncmec_submit_retry_delay_4_ms` | `86400000` | integer | `60000` | `604800000` | row/type/bounds only — current value may legitimately differ |

2. **The live `quarantine_id` backfill actually linked what it could —
   verify against real data, not just the schema.** Migration `0097` isn't
   schema-only: it also backfilled `ncmec_reports.quarantine_id` from
   `request_metadata` on every pre-existing row, classifying each into
   `missing` (no `quarantineId` in `request_metadata` — legitimate; these
   are pre-stub rows and are meant to stay `NULL` as the backlog audit's
   population), `malformed` (a `quarantineId` present but not numeric-shaped
   — a real defect), or `dangling` (numeric but no matching
   `quarantined_memes` row — a real defect). The migration's own run logged
   these counts via `RAISE NOTICE`; if Replit's deploy log from the original
   migration run is still available, read the counts from there. Either
   way, also run this **live, read-only** verification against the current
   data (safe to run any time — it only counts, never writes) since the
   classification is fully re-derivable from current state:
   ```sql
   SELECT
     count(*) FILTER (WHERE request_metadata->>'quarantineId' IS NULL) AS missing,
     count(*) FILTER (WHERE request_metadata->>'quarantineId' !~ '^[0-9]{1,18}$') AS malformed,
     count(*) FILTER (
       WHERE request_metadata->>'quarantineId' ~ '^[0-9]{1,18}$'
         AND NOT EXISTS (
           SELECT 1 FROM quarantined_memes q
            WHERE q.id = (request_metadata->>'quarantineId')::bigint
         )
     ) AS dangling,
     count(*) FILTER (
       WHERE request_metadata->>'quarantineId' ~ '^[0-9]{1,18}$'
         AND EXISTS (
           SELECT 1 FROM quarantined_memes q
            WHERE q.id = (request_metadata->>'quarantineId')::bigint
         )
     ) AS linkable_but_unlinked
   FROM ncmec_reports
   WHERE quarantine_id IS NULL;
   ```
   Expected: `missing` can be any count (that's the intended, unlinked
   backlog population — not a failure). **`malformed`, `dangling`, and
   `linkable_but_unlinked` must all be reported and explicitly
   dispositioned, not silently accepted.** `linkable_but_unlinked` is the
   one that matters most: a row with a valid, numeric `quarantineId`
   pointing at a real `quarantined_memes` row that is *still* unlinked
   matches none of the other three buckets, so without this one the whole
   check can read "all zero, looks clean" while the exact failure it exists
   to catch — a linkable row the backfill missed — is still present. A
   nonzero count in any of the three means a real row that should be linked
   isn't, which leaves the `UQ_ncmec_reports_quarantine` partial unique
   index unable to constrain it and lets the later orphan reconciler
   potentially create a second report for the same hit (breaking the
   one-report-per-hit invariant this migration exists partly to protect).
   If any is nonzero, flag it to David rather than treating this check as
   passed.

3. **Re-running migration `0097` — describe what actually happens, not an
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

4. **The append-only guarantee — probe inside a transaction that always
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

5. **The reserved-config-key guard rejects filing-capable keys.** As an
   admin, `PATCH /api/admin/config/ncmec_submission_enabled` (or any of the
   other four reserved keys — see below) with any body — expect **403**
   with the reserved-key refusal message, not the normal validation
   response. **Before** testing `ncmec_safety_alert_email`, record its
   current value — recording it only after the PATCH would capture the
   value your own test just wrote, not the original one, and "restoring"
   that would leave the row permanently changed. Then `PATCH
   /api/admin/config/ncmec_safety_alert_email` with a valid string, which
   should succeed normally (it is deliberately not reserved — see the note
   below), and restore the value you recorded beforehand** (see the cleanup
   note below) — this is a real write against a persistent, live-effect
   config row.

## Cleanup — restore any config rows this checklist wrote

Step 5 above successfully writes to `ncmec_safety_alert_email` (a real,
persistent `admin_config` row that will govern real alert routing once
production filing exists). Before finishing this checklist: note that row's
value **before** running step 5, and set it back to that value afterward.

**If it was empty before your test (the default, out-of-the-box state —
per the seed table above), restoring it is NOT a normal PATCH.** The
generic config route rejects an empty string for text-type keys (see
`NCMEC_UNRESERVED_CONFIG_KEYS`'s own doc comment in `ncmecConfig.ts`: "an
admin can write any *nonempty* string"), so a PATCH back to `""` fails with
400 — you cannot get back to empty through the surface you just tested
with. Restore it at the database level instead, which is exactly how the
seed itself got there (raw SQL, not the app route):
```sql
UPDATE admin_config SET value = '' WHERE key = 'ncmec_safety_alert_email';
```
If it already held a real (non-empty) value before your test, the normal
PATCH restore works fine — this exception only applies to the empty case.

Do the same value-capture-and-restore for either of the other two
unreserved keys (`async_job_ncmec_submit_max_attempts`,
`async_job_ncmec_submit_retry_delay_4_ms`) if you additionally exercised
them while testing (both are numeric with real seeded defaults, so their
normal PATCH restore path always works — no empty-string exception for
either). The five reserved keys need no cleanup — every attempt against
them is refused before any write happens.

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
