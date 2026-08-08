# PR293 — NCMEC CyberTipline reporting, phases 1-2 of 8 · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no DATABASE_URL / test-DB env
is set here.

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
```
bash artifacts/api-server/scripts/run-test.sh \
  artifacts/api-server/src/__tests__/migrations.0097.test.ts \
  artifacts/api-server/src/__tests__/moderation.ncmecClient.test.ts \
  artifacts/api-server/src/__tests__/routes.admin.test.ts
```
Expected: **0 fail**. `migrations.0097.test.ts` covers the append-only
audit-ledger triggers, the reserved-config-key lockstep between the SQL
constraint/seed list and the TypeScript constants, and the migration's own
warning-on-unenforced-boundary behavior. `moderation.ncmecClient.test.ts`
covers the ISPWS HTTP client and XML builders against committed fixtures
with zero network access. `routes.admin.test.ts` includes the reserved-key
403 refusal on `PATCH /admin/config/:key`.

Also run `lib/db`'s own suite directly (see "Full sharded suite" below for
why this is now wired into CI as a separate step, not folded into
api-server's shards):
```
pnpm --filter @workspace/db exec vitest run src/ncmecAuditBoundaryStatus.test.ts
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
1. **Migration `0097` applied** — confirm `ncmec_safety_audit_log` exists
   (`bigserial id`, `report_id bigint`, `actor_label text NOT NULL`,
   `action varchar(40) NOT NULL`, `created_at timestamptz NOT NULL`), that
   `ncmec_reports` carries the `ncmec_reports_submission_status_check`
   constraint and the `ncmec_reports_link_quarantine_trg` trigger, and that
   `admin_config` has 8 new rows with keys prefixed `ncmec_` or
   `async_job_ncmec_submit_`.
2. **Re-running migration `0097` is a no-op** — every `CREATE TABLE`/
   `CREATE INDEX`/`CREATE TRIGGER` is `IF NOT EXISTS`, the `admin_config`
   seed is `ON CONFLICT ("key") DO NOTHING`, and the CHECK-constraint
   rebuild block only fires when the live constraint's definition doesn't
   already match — confirm a second `pnpm --filter @workspace/db run
   migrate` changes nothing and raises no error.
3. **The append-only guarantee is enforced today, but only at the
   application-role level.** As a normal (non-superuser) DB session,
   attempt `UPDATE ncmec_safety_audit_log SET reason = 'x' WHERE id = 1`
   and `DELETE FROM ncmec_safety_audit_log WHERE id = 1` against any
   existing row (or a row you insert for the test) — both must raise
   `ncmec_safety_audit_log is append-only`. This is enforced by a database
   trigger, not application code, so it holds regardless of which route or
   script attempts the write.
4. **The reserved-config-key guard rejects filing-capable keys.** As an
   admin, `PATCH /api/admin/config/ncmec_submission_enabled` (or any of the
   other four reserved keys — see below) with any body — expect **403**
   with the reserved-key refusal message, not the normal validation
   response. `PATCH /api/admin/config/ncmec_safety_alert_email` with a
   valid string, by contrast, should succeed normally — it is deliberately
   not reserved (see the note below).

## What's deliberately NOT shipped
- No caller for the ISPWS client/XML builders yet — nothing can file a
  report with NCMEC. Both `ncmec_submission_enabled` and
  `ncmec_report_classifier_hits` are seeded `false`.
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
