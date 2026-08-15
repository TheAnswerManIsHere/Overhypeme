# PR293 — NCMEC CyberTipline reporting, phases 1-2 of 8 · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. **Replit owns the DB connection** — no `DATABASE_URL` /
test-DB env is set anywhere in this doc.

Pre-merge gates (install, typecheck, codegen drift) are assumed green;
spot-check only if something below fails. Note: `artifacts/api-server`
gained a new direct dependency, `fast-xml-parser` (pinned `5.10.1`) — if
`pnpm install --frozen-lockfile` fails, that's the first thing to check.

**No test suites in this checklist, deliberately.** This PR's feature
(#293) is covered by `migrations.0097.test.ts`,
`moderation.ncmecClient.test.ts`, `routes.admin.test.ts`, and
`@workspace/db`'s own `ncmecAuditBoundaryStatus.test.ts` — all of which
already ran and passed in CI against a real Postgres, on this exact code.
Re-running them here would verify nothing new, and two of them create
PostgreSQL **roles**, which are cluster-global rather than per-database —
so running them against this long-lived workspace could leave stray roles
behind or collide with the real `overhype_audit_maintenance` role and fail
for a reason that has nothing to do with the code. Everything below is
what CI genuinely *cannot* see: the state of the live database and the
live app.

## Repo-health gates (post-merge state — run always)
- `pnpm --filter @workspace/db validate-snapshots` — expected: passes
  (matches CI's `build.yml`)
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entry this PR added: `0097_ncmec_submission`
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: none

## Live checks (run always)

All three are read-only against the live database, except check 3's single
deliberately-rejected HTTP request. **Nothing below writes a row.**

### 1. Migration `0097` applied — full schema check

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
`backlog_audit_note`, `identity_omission_approved_at`, `manual_report_id`
(`varchar(64)`) — every one nullable or defaulted, no exceptions.

`quarantined_memes` carries 4 new columns: `content_origin`
(`varchar(16)`), `report_intent` (`boolean`), `reporter_snapshot`
(`jsonb`), `request_metadata` (`jsonb`).

**Constraints, keys, and indexes — verify the definitions, not just the
names.** A drifted same-named constraint satisfies a name-only check while
leaving the invariant unenforced.

On `ncmec_reports`:
- `ncmec_reports_submission_status_check`:
  `CHECK (submission_status IN ('pending','in_progress','submitted','filed_manually','failed','not_reportable'))`
  — exactly these 6 values.
- `ncmec_reports_content_origin_check`:
  `CHECK (content_origin IS NULL OR content_origin IN ('generated','user_upload','stock','template','identity'))`
  — exactly these 5 values, nullable.
- `ncmec_reports_quarantine_id_fk`: `quarantine_id` →
  `quarantined_memes.id`, **`ON DELETE SET NULL`**, `ON UPDATE NO ACTION`.
- `ncmec_reports_link_quarantine_trg` trigger.
- `UQ_ncmec_reports_quarantine`: unique on `quarantine_id` WHERE
  `quarantine_id IS NOT NULL`. This is the one-report-per-quarantine-hit
  guarantee — a partial migration missing just this index passes every
  other check here while leaving that invariant unenforced.
- `IDX_ncmec_nonfinal` and `IDX_ncmec_failed_unalerted` indexes.

On `quarantined_memes`: `quarantined_memes_content_origin_check` — same
definition as `ncmec_reports`' (5 values, nullable).

On `ncmec_safety_audit_log`:
- `ncmec_safety_audit_log_action_check`:
  `CHECK (action IN ('retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write'))`
  — the closed action vocabulary, exactly these 9 values.
- `ncmec_safety_audit_log_report_id_fk`: `report_id` → `ncmec_reports.id`,
  **`ON DELETE RESTRICT`** — deliberately not `SET NULL`, so the ledger
  can never lose which report an entry was about — `ON UPDATE NO ACTION`.
- `IDX_ncmec_audit_report_created` and `IDX_ncmec_audit_created` indexes.

**Both append-only triggers, plus the function they call.** This is the
audit ledger's whole protection, so verify the wiring end to end:

| Trigger | Fires on | Enabled | Function |
|---|---|---|---|
| `ncmec_safety_audit_log_no_mutate` | `BEFORE UPDATE OR DELETE`, `FOR EACH ROW` | `ALWAYS` (`tgenabled = 'A'`, not the default `'O'` — `'O'`-only lets a session that sets `session_replication_role = replica` bypass it) | `ncmec_safety_audit_log_append_only()` |
| `ncmec_safety_audit_log_no_truncate` | `BEFORE TRUNCATE`, `FOR EACH STATEMENT` | `ALWAYS` (same reason) | `ncmec_safety_audit_log_append_only()` |

Then confirm the **function itself** still implements the guard — a
trigger pointing at a same-named function whose body was replaced with
something permissive passes the table above while leaving the ledger
erasable:

```sql
SELECT prosrc LIKE '%is append-only%' AS guard_body_intact
  FROM pg_proc
 WHERE proname = 'ncmec_safety_audit_log_append_only';
```
Expected: one row, `true`. (`lib/db`'s `ncmecAuditBoundaryStatus()` does
this same check as `guardFunctionIntact`, alongside the ownership checks —
worth reading if you want the fuller picture, but the SQL above is
sufficient here.)

**Seeded `admin_config` rows.** The 5 reserved keys' values are exact and
required — nothing can write to them today, so any drift means a partial
or corrupted migration. The 3 unreserved keys are legitimately editable,
and the seed's `ON CONFLICT ("key") DO NOTHING` exists specifically to
preserve an operator's later change: verify the row, type, and bounds, but
treat the current *value* as live state to leave alone.

| Key | Seeded value | Type | Min | Max | Value check |
|---|---|---|---|---|---|
| `ncmec_submission_enabled` | `false` | boolean | — | — | must equal seed |
| `ncmec_ispws_environment` | `test` | text | — | — | must equal seed |
| `ncmec_report_classifier_hits` | `false` | boolean | — | — | must equal seed |
| `ncmec_backlog_audit_cutoff` | `` (empty) | text | — | — | must equal seed |
| `ncmec_backlog_audit_completed_at` | `` (empty) | text | — | — | must equal seed |
| `ncmec_safety_alert_email` | `` (empty) | text | — | — | row/type/bounds only |
| `async_job_ncmec_submit_max_attempts` | `8` | integer | `1` | `20` | row/type/bounds only |
| `async_job_ncmec_submit_retry_delay_4_ms` | `86400000` | integer | `60000` | `604800000` | row/type/bounds only |

### 2. The live `quarantine_id` backfill linked what it could

Migration `0097` isn't schema-only: it also backfilled
`ncmec_reports.quarantine_id` from `request_metadata` on every pre-existing
row. Only the live database can show how that turned out. This query is
**read-only** — it only counts:

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

Expected: `missing` can be any count — those are pre-stub rows with no
`quarantineId` to link, and they're meant to stay `NULL`.

**`linkable_but_unlinked` must be zero, and a nonzero count needs flagging
to David rather than accepting.** It's the bucket that matters: a row with a
valid `quarantineId` pointing at a real `quarantined_memes` row that's
*still* unlinked matches none of the other buckets, so without it the check
could read "all clean" while the exact failure it exists to catch is
present. Such a row leaves `UQ_ncmec_reports_quarantine` unable to constrain
it and lets the later orphan reconciler create a second report for the same
hit — breaking the one-report-per-hit invariant.

**`malformed` and `dangling` being nonzero is NOT a stop condition — record
them and keep going.** Both name a `quarantineId` that resolves to no
`quarantined_memes` row at all, so there is nothing for the orphan
reconciler's unreferenced-quarantine pass to find and no second report it
can create; the duplicate-report risk above is specific to
`linkable_but_unlinked`. Migration 0097 classifies both as a
`RAISE WARNING` rather than an exception for exactly that reason — only
`conflicting` (two reports claiming the same quarantine row) aborts it.
Note the counts and the offending `ncmec_reports.id` values in the run
report and move on. Do **not** write a repair migration, delete or fabricate
rows, or relax the invariant to make the run green.

Their disposition is already settled and needs no per-row decision: the
platform has never been live, so every `ncmec_reports` / `quarantined_memes`
row in the database today is a test artifact rather than evidence, and the
activation runbook deletes all of them before the filing switch is thrown
(David, 2026-08-07 — see the header of
`artifacts/api-server/src/lib/moderation/ncmecWorker.ts`). That decision
retired the "pre-activation backlog audit" these rows were originally
deferred to, which is why `ncmec_backlog_audit_cutoff` /
`ncmec_backlog_audit_completed_at` above — and 0097's `backlog_audited_at` /
`backlog_audit_note` columns and its own warning text — are vestigial.

### 3. The reserved-config-key guard refuses filing-capable keys

As an admin, `PATCH /api/admin/config/ncmec_submission_enabled` (or any of
the other four reserved keys: `ncmec_ispws_environment`,
`ncmec_report_classifier_hits`, `ncmec_backlog_audit_cutoff`,
`ncmec_backlog_audit_completed_at`) with any body.

Expected: **403** with the reserved-key refusal message, not the normal
validation response.

**No cleanup needed** — the refusal happens before any write, so nothing
is persisted by this check regardless of how many times you run it. That's
also why this checklist doesn't ask you to exercise the three *unreserved*
keys: a successful write there is real and persistent, and
`ncmec_safety_alert_email` in particular can't be set back to its seeded
empty value through the same route (the generic config route rejects empty
strings). Their editability is covered in the UAT instead, where David can
decide what to touch on his own settings.

## What's deliberately NOT shipped
- No caller for the ISPWS client/XML builders yet — nothing can file a
  report with NCMEC. `ncmec_submission_enabled` and
  `ncmec_report_classifier_hits` are seeded `false`, and — as of a later
  phase already on `main` (#349) — `ncmec_backlog_audit_cutoff` and
  `ncmec_backlog_audit_completed_at` are vestigial for filing-eligibility
  purposes specifically (`isSubmittable()` no longer reads them, pending a
  cleanup migration); they are still real seeded config rows and the
  generic route still refuses to write them, which is what check 3 tests.
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
