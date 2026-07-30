-- NCMEC CyberTipline submission — phase 1 of PLAN_NCMEC_CYBERTIPLINE_SUBMISSION.md.
--
-- Schema only. Nothing in this migration can file a report: the worker and the
-- reconciler do not exist yet (phase 5), and the two switches that would let
-- them run are seeded OFF. What this migration DOES do is make every later
-- phase's state expressible — status vocabulary, lease columns, provenance,
-- the audit ledger — and close the one hole that opening it would otherwise
-- create (see the reserved-key rejection in admin.ts, shipped in this same
-- commit: seeding `ncmec_submission_enabled` into `admin_config` makes it
-- writable through the generic PATCH /admin/config/:key route, which knows
-- nothing about backlog audits).
--
-- Hand-authored idempotent DDL. `drizzle-kit generate` stays broken on the
-- malformed 0063 snapshot (docs/engineering/migrations-and-backfills.md:21-26),
-- so this ships with a SNAPSHOT_EXEMPT_TAGS entry instead of a generated
-- snapshot, following 0093/0094's shape.
-- Source of truth: lib/db/src/schema/moderation.ts.

-- ─── 1. ncmec_reports: the submission lifecycle ─────────────────────────────
--
-- Every column is nullable or defaulted, so the OLD code (which writes only
-- `pending` and reads none of these) stays correct against the new schema.
-- That is what makes migration-before-code safe in both directions.

ALTER TABLE "ncmec_reports"
  ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "finish_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_error" text,
  ADD COLUMN IF NOT EXISTS "last_error_code" integer,
  ADD COLUMN IF NOT EXISTS "submission_environment" varchar(16),
  ADD COLUMN IF NOT EXISTS "uploaded_files" jsonb,
  ADD COLUMN IF NOT EXISTS "retracted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "submission_lease_owner" text,
  ADD COLUMN IF NOT EXISTS "submission_lease_until" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "manually_filed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "test_submitted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "test_submission_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "test_report_id" varchar(64),
  ADD COLUMN IF NOT EXISTS "quarantine_id" bigint,
  ADD COLUMN IF NOT EXISTS "failed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_attempt_failed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "alert_notified_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "content_origin" varchar(16),
  ADD COLUMN IF NOT EXISTS "reporter_snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "backlog_audited_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "backlog_audit_note" text,
  ADD COLUMN IF NOT EXISTS "identity_omission_approved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "manual_report_id" varchar(64);
--> statement-breakpoint

-- `manual_report_id` is deliberately NOT `report_id`. `report_id` means "ISPWS
-- returned this from OUR OWN /submit", and the duplicate-filing guard retracts
-- against it. An operator-typed id in that column would be read as our own
-- prior attempt: a `reopen` would /retract against an id we never obtained,
-- and if that id happens to identify someone else's finished report the guard
-- receives 5102, concludes "our previous attempt landed", and marks this row
-- `submitted` — a report that was never filed, made permanently final by a typo.
COMMENT ON COLUMN "ncmec_reports"."manual_report_id" IS
  'CyberTipline id an operator TYPED for a hand-filed report. Never read by the duplicate-filing guard — that reads report_id only.';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ncmec_reports_quarantine_id_fk'
       AND conrelid = '"ncmec_reports"'::regclass
  ) THEN
    ALTER TABLE "ncmec_reports"
      ADD CONSTRAINT "ncmec_reports_quarantine_id_fk"
      FOREIGN KEY ("quarantine_id") REFERENCES "public"."quarantined_memes"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint

-- ─── 2. Status vocabulary ───────────────────────────────────────────────────
--
-- pending | in_progress | submitted | filed_manually | failed | not_reportable
--
-- Final: submitted, filed_manually, failed, not_reportable.
-- Non-final: pending, in_progress.
--
-- There is deliberately NO `retracted` status. Retraction is a step within an
-- attempt, not a place a report rests; a status would create a non-final state
-- a crash could strand a row in, outside every reconciler repair. `retracted_at`
-- records it instead and the row stays `in_progress` throughout.
--
-- Keep in lockstep with NCMEC_SUBMISSION_STATUSES in lib/db/src/schema/moderation.ts.
-- migrations.0095.test.ts asserts the two agree, so the lockstep is enforced
-- rather than remembered.
ALTER TABLE "ncmec_reports" DROP CONSTRAINT IF EXISTS "ncmec_reports_submission_status_check";
--> statement-breakpoint
ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_submission_status_check"
  CHECK ("submission_status" IN ('pending','in_progress','submitted','filed_manually','failed','not_reportable'));
--> statement-breakpoint

-- ─── 3. quarantined_memes: provenance frozen at quarantine time ─────────────
--
-- The orphan sweep must be able to rebuild a report from the quarantine row
-- ALONE. Without these it would have to re-evaluate the MUTABLE classifier flag
-- (making whether a hit is reported depend on when a background job happened to
-- run) and resolve the uploader LIVE — by which time the account may have been
-- renamed, soft-deleted, or had its email nulled. Persisting the inputs makes
-- the sweep a pure function of the row.

ALTER TABLE "quarantined_memes"
  ADD COLUMN IF NOT EXISTS "content_origin" varchar(16),
  ADD COLUMN IF NOT EXISTS "report_intent" boolean,
  ADD COLUMN IF NOT EXISTS "reporter_snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "request_metadata" jsonb;
--> statement-breakpoint

-- Nullable, and null is NOT false: it means "pre-migration, intent unknowable".
-- Null intent then splits by `source` — arachnid rows are recovered by the
-- sweep (that rule never depended on config), every other source is skipped and
-- surfaced for an operator instead.
COMMENT ON COLUMN "quarantined_memes"."report_intent" IS
  'Reportability decision frozen at quarantine time. NULL means pre-migration/unknowable — NOT false.';
--> statement-breakpoint

-- `is_generative` is deliberately NOT stored. It is computed where it is used
-- (content_origin = 'generated'); persisting it too would be two
-- representations of one fact that can disagree, and the report's
-- <generativeAi> annotation would depend on which one the mapping read.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quarantined_memes_content_origin_check'
  ) THEN
    ALTER TABLE "quarantined_memes" ADD CONSTRAINT "quarantined_memes_content_origin_check"
      CHECK ("content_origin" IS NULL OR "content_origin" IN ('generated','user_upload','stock','template','identity'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ncmec_reports_content_origin_check'
  ) THEN
    ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_content_origin_check"
      CHECK ("content_origin" IS NULL OR "content_origin" IN ('generated','user_upload','stock','template','identity'));
  END IF;
END $$;
--> statement-breakpoint

-- ─── 4. Backfill quarantine_id, BEFORE the unique index exists ──────────────
--
-- Every pre-existing ncmec_reports row has a NULL quarantine_id because the
-- column is new. The reconciler's orphan pass selects quarantine rows that no
-- report references — so without this backfill it would classify EVERY legacy
-- Arachnid quarantine as unreported and insert a second report for it. Two
-- report rows for one hit, each independently filable: invariant 7 broken
-- across the entire back catalogue, by the mechanism added to protect it.
--
-- The link is recoverable because the existing stub already persists it:
-- quarantine.ts writes `quarantineId: row?.id` into request_metadata,
-- server-side, on every report it creates.
--
-- The value is UNVALIDATED JSON, so it is classified before anything is cast.
-- A bare `(request_metadata->>'quarantineId')::bigint` raises on the first
-- non-numeric value and aborts the whole migration; a numeric-but-dangling id
-- would fit none of the reported counts. The CTEs below are MATERIALIZED so
-- the regex filter is a genuine barrier and the cast never sees a bad value.
-- migrations.0095.test.ts slices on the two sentinels below so it can replay
-- the classification against fixtures without re-running the whole migration.
-- Keep them wrapping exactly the DO block, and keep each sentinel alone on its
-- line — the test executes everything between them verbatim.
-- >>> ncmec-0095 backfill block (start)
DO $$
DECLARE
  n_missing     bigint;
  n_malformed   bigint;
  n_dangling    bigint;
  n_conflicting bigint;
  n_linked      bigint;
  conflict_ids  text;
BEGIN
  DROP TABLE IF EXISTS _ncmec_0095_candidates;

  CREATE TEMP TABLE _ncmec_0095_candidates AS
  WITH raw AS MATERIALIZED (
    SELECT r.id AS report_id, r.request_metadata->>'quarantineId' AS raw_qid
      FROM ncmec_reports r
     WHERE r.quarantine_id IS NULL
  ),
  typed AS MATERIALIZED (
    SELECT report_id,
           raw_qid,
           CASE WHEN raw_qid IS NULL THEN 'missing'
                WHEN raw_qid !~ '^[0-9]+$' THEN 'malformed'
                ELSE 'numeric' END AS shape
      FROM raw
  )
  SELECT t.report_id,
         t.raw_qid,
         CASE WHEN t.shape <> 'numeric' THEN NULL ELSE t.raw_qid::bigint END AS qid,
         t.shape
    FROM typed t;

  -- Dangling: numerically valid but pointing at no quarantine row.
  UPDATE _ncmec_0095_candidates c
     SET shape = 'dangling'
   WHERE c.shape = 'numeric'
     AND NOT EXISTS (SELECT 1 FROM quarantined_memes q WHERE q.id = c.qid);

  -- Conflicting: two or more reports claiming the SAME quarantine row. Never
  -- auto-picked — choosing one would silently discard a real report's linkage,
  -- and the choice is exactly the judgement a human has to make.
  UPDATE _ncmec_0095_candidates c
     SET shape = 'conflicting'
   WHERE c.shape = 'numeric'
     AND (
       EXISTS (SELECT 1 FROM _ncmec_0095_candidates o
                WHERE o.qid = c.qid AND o.report_id <> c.report_id AND o.shape = 'numeric')
       OR EXISTS (SELECT 1 FROM ncmec_reports r
                   WHERE r.quarantine_id = c.qid AND r.id <> c.report_id)
     );

  SELECT count(*) FILTER (WHERE shape = 'missing'),
         count(*) FILTER (WHERE shape = 'malformed'),
         count(*) FILTER (WHERE shape = 'dangling'),
         count(*) FILTER (WHERE shape = 'conflicting'),
         count(*) FILTER (WHERE shape = 'numeric')
    INTO n_missing, n_malformed, n_dangling, n_conflicting, n_linked
    FROM _ncmec_0095_candidates;

  IF n_conflicting > 0 THEN
    SELECT string_agg(DISTINCT c.qid::text, ', ' ORDER BY c.qid::text)
      INTO conflict_ids
      FROM _ncmec_0095_candidates c WHERE c.shape = 'conflicting';
    RAISE EXCEPTION
      '0095: % ncmec_reports rows claim a quarantine row another report already claims (quarantined_memes ids: %). Resolve by hand before migrating — pick the authoritative report per quarantine row and clear the other''s request_metadata->>''quarantineId''. Auto-picking would silently discard a real report''s linkage.',
      n_conflicting, conflict_ids;
  END IF;

  UPDATE ncmec_reports r
     SET quarantine_id = c.qid
    FROM _ncmec_0095_candidates c
   WHERE r.id = c.report_id
     AND c.shape = 'numeric';

  -- Observability, per the migration-review rule: a backfill that reports
  -- nothing cannot be told from one that matched nothing.
  RAISE NOTICE '0095 quarantine_id backfill: linked=%, missing=% (pre-stub rows — stay NULL, they are the backlog audit''s population), malformed=%, dangling=%',
    n_linked, n_missing, n_malformed, n_dangling;

  IF n_malformed > 0 OR n_dangling > 0 THEN
    RAISE WARNING '0095: % malformed and % dangling quarantineId values left NULL. These rows are unlinked and must be dispositioned by the pre-activation backlog audit.',
      n_malformed, n_dangling;
  END IF;

  DROP TABLE _ncmec_0095_candidates;
END $$;
-- <<< ncmec-0095 backfill block (end)
--> statement-breakpoint

-- ─── 5. Indexes ─────────────────────────────────────────────────────────────
--
-- Three, each backing a query the reconciler runs on a timer.

-- Pass 1: non-final rows.
CREATE INDEX IF NOT EXISTS "IDX_ncmec_nonfinal"
  ON "ncmec_reports" ("submission_status", "id")
  WHERE "submission_status" IN ('pending','in_progress');
--> statement-breakpoint

-- Pass 3: terminal failures nobody has been told about. The
-- `alert_notified_at IS NULL` term is the whole point — it is what keeps the
-- result set small (empty in steady state). Partial on `failed` alone, the
-- index would grow with the entire failure history and force every sweep to
-- scan and heap-filter all of it to find nothing.
CREATE INDEX IF NOT EXISTS "IDX_ncmec_failed_unalerted"
  ON "ncmec_reports" ("id")
  WHERE "submission_status" = 'failed' AND "alert_notified_at" IS NULL;
--> statement-breakpoint

-- A CORRECTNESS constraint, not a performance one: this is what makes two
-- concurrent orphan sweeps produce one report row instead of two independently
-- filable ones. Postgres permits many NULLs in a unique index, so unlinked
-- legacy rows are unaffected. Created AFTER the backfill, so a pre-existing
-- duplicate surfaces here rather than being silently skipped.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ncmec_reports_quarantine"
  ON "ncmec_reports" ("quarantine_id") WHERE "quarantine_id" IS NOT NULL;
--> statement-breakpoint

-- ─── 6. ncmec_safety_audit_log — append-only ────────────────────────────────
--
-- Every action on /admin/safety alters state with legal consequence. Without
-- this table the design recorded NO ACTOR AT ALL: not on retry, send-to-test,
-- backlog audit, or manual filing. `admin_config.updated_by_id` preserves only
-- the LATEST writer, so even a config write that sets it is overwritten by the
-- next one. An operator who marks forty rows filed_manually with fabricated
-- report ids has permanently suppressed forty federal reports and left a ledger
-- that reads as complete.

CREATE TABLE IF NOT EXISTS "ncmec_safety_audit_log" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "report_id" bigint,
  "actor_user_id" varchar,
  -- NOT NULL is load-bearing. The obvious alternative — a nullable
  -- actor_email_snapshot — does not survive this schema: users.email is
  -- nullable, PATCH /admin/users/:id lets an admin clear it, and
  -- softDeleteUserLifecycle nulls it outright. An admin with no email could
  -- suppress a report and leave an entry whose only identity is a user_id that
  -- becomes an orphaned opaque string once the account is deleted.
  "actor_label" text NOT NULL,
  "action" varchar(40) NOT NULL,
  "reason" text,
  "before_state" jsonb,
  "after_state" jsonb,
  "attempt_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `actor_user_id` carries NO foreign key, deliberately. A FK would make the
-- ledger's contents depend on the users table: an ON DELETE SET NULL would
-- erase the machine-readable half of the attribution when an account is
-- deleted, and any other action would either block the delete or cascade into
-- this table. The actor is denormalized into `actor_label` instead, so deleting
-- the account cannot touch the ledger at all. `report_id` does carry one,
-- because a report row is the thing an entry is ABOUT and its absence is
-- meaningful rather than lossy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ncmec_safety_audit_log_report_id_fk'
       AND conrelid = '"ncmec_safety_audit_log"'::regclass
  ) THEN
    ALTER TABLE "ncmec_safety_audit_log"
      ADD CONSTRAINT "ncmec_safety_audit_log_report_id_fk"
      FOREIGN KEY ("report_id") REFERENCES "public"."ncmec_reports"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "IDX_ncmec_audit_report_created"
  ON "ncmec_safety_audit_log" ("report_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_ncmec_audit_created"
  ON "ncmec_safety_audit_log" ("created_at" DESC);
--> statement-breakpoint

-- The maintenance role. Granted to NOBODY by default; a deliberate correction
-- means a DBA granting it, which is auditable outside this database.
--
-- The bypass is ROLE MEMBERSHIP, not a settable GUC. `SET LOCAL
-- app.audit_maintenance = 'on'` would be available to the same application role
-- whose raw UPDATE/DELETE/TRUNCATE this trigger exists to block — an
-- application convention wearing a database guarantee's clothes, which is the
-- exact criticism that produced this trigger.
--
-- Best-effort: a deployment whose application role lacks CREATEROLE must not
-- fail its deploy here. The trigger function fails CLOSED when the role is
-- absent (see below), so a skipped creation makes the ledger stricter, never
-- looser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_maintenance') THEN
    BEGIN
      CREATE ROLE overhype_audit_maintenance NOLOGIN;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING '0095: could not create role overhype_audit_maintenance (insufficient privilege). The append-only trigger fails closed without it: no session can UPDATE, DELETE or TRUNCATE ncmec_safety_audit_log until a DBA creates the role. Create it with: CREATE ROLE overhype_audit_maintenance NOLOGIN;';
    END;
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ncmec_safety_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  -- The EXISTS guard is not defensive noise: pg_has_role RAISES on a role that
  -- does not exist, so without it a deployment that could not create the role
  -- would block every operation with a confusing "role does not exist" error
  -- instead of this one. Fails closed either way; this fails closed legibly.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_maintenance')
     OR NOT pg_has_role(current_user, 'overhype_audit_maintenance', 'member') THEN
    RAISE EXCEPTION 'ncmec_safety_audit_log is append-only (%)', TG_OP
      USING HINT = 'Membership of overhype_audit_maintenance is required to modify this ledger.';
  END IF;
  -- Maintenance is permitted: let the operation through. RETURN NULL here would
  -- silently CANCEL it — in a BEFORE row trigger a NULL return cancels the
  -- operation — which is the exact opposite of what the escape hatch is for:
  -- failing closed while appearing to succeed.
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint

-- DROP IF EXISTS before each CREATE, because this migration is required to be
-- rerunnable and an unguarded CREATE TRIGGER fails on the second pass — which
-- is exactly what a partially-recovered deployment does.
DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_mutate ON "ncmec_safety_audit_log";
--> statement-breakpoint
CREATE TRIGGER ncmec_safety_audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON "ncmec_safety_audit_log"
  FOR EACH ROW EXECUTE FUNCTION ncmec_safety_audit_log_append_only();
--> statement-breakpoint

-- TRUNCATE is covered too, by a STATEMENT-level trigger sharing the same gate.
-- A row trigger does not fire on TRUNCATE, so leaving it out would let the
-- application role erase the entire ledger with one statement — on the table
-- that is the sole control over destructive admin actions.
DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_truncate ON "ncmec_safety_audit_log";
--> statement-breakpoint
CREATE TRIGGER ncmec_safety_audit_log_no_truncate
  BEFORE TRUNCATE ON "ncmec_safety_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION ncmec_safety_audit_log_append_only();
--> statement-breakpoint

-- Ownership hardening, when a DBA has pre-provisioned the owner role.
--
-- The trigger blocks row mutation, but `ALTER TABLE ... DISABLE TRIGGER`
-- requires only OWNERSHIP — and this migration runs as the application role,
-- which therefore owns everything it creates. A migration cannot manufacture a
-- privilege boundary above itself: transferring ownership requires membership
-- of the target role, and membership is exactly what would let the application
-- role SET ROLE back and disable the trigger anyway.
--
-- So the boundary is completed OUTSIDE this migration, by a DBA who creates
-- `overhype_audit_owner` and grants the application role no membership in it.
-- This block picks that up when it is present and is a no-op when it is not.
-- The residual state is queryable — see ncmecAuditBoundaryStatus() in
-- lib/db — and the phase 6 activation gate refuses production while the
-- boundary is unenforced, which blocks the dangerous STATE rather than one
-- path into it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_owner')
     AND pg_has_role(current_user, 'overhype_audit_owner', 'member') THEN
    EXECUTE 'ALTER TABLE "ncmec_safety_audit_log" OWNER TO overhype_audit_owner';
    EXECUTE 'ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO overhype_audit_owner';
    -- The application role keeps exactly what it needs to append and read.
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE "ncmec_safety_audit_log" TO %I', current_user);
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE "ncmec_safety_audit_log_id_seq" TO %I', current_user);
    RAISE NOTICE '0095: ncmec_safety_audit_log ownership transferred to overhype_audit_owner.';
  ELSE
    RAISE WARNING '0095: ncmec_safety_audit_log is owned by the application role, so ALTER TABLE ... DISABLE TRIGGER can still bypass the append-only guarantee. To complete the boundary, a DBA must run: CREATE ROLE overhype_audit_owner NOLOGIN; ALTER TABLE ncmec_safety_audit_log OWNER TO overhype_audit_owner; ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO overhype_audit_owner; GRANT SELECT, INSERT ON ncmec_safety_audit_log TO <app_role>; GRANT USAGE, SELECT ON SEQUENCE ncmec_safety_audit_log_id_seq TO <app_role>; -- and must NOT grant the app role membership of overhype_audit_owner.';
  END IF;
END $$;
--> statement-breakpoint

-- ─── 7. Config seeds ────────────────────────────────────────────────────────
--
-- Seeded here rather than left to code defaults, and that is load-bearing for
-- the two retry keys specifically: without a seed, production keeps the queue
-- defaults (5 attempts, 8-hour fourth delay) and exhausts at ~10.5 hours while
-- the design assumes ~98.6. A test that injects the config would pass against a
-- production that never had it.
--
-- ON CONFLICT DO NOTHING throughout: re-running this migration must never
-- reset a value an operator has since changed.

INSERT INTO "admin_config" ("key", "value", "data_type", "label", "description", "min_value", "max_value", "is_public") VALUES
  ('ncmec_submission_enabled', 'false', 'boolean', 'NCMEC Submission Enabled',
   'Master switch for automated CyberTipline filing. False means the submission job no-ops and reports stay pending — today''s behavior. Writable only through the guarded /admin/safety config endpoint, which refuses activation while the backlog audit is incomplete.',
   NULL, NULL, false),
  ('ncmec_ispws_environment', 'test', 'text', 'NCMEC ISPWS Environment',
   'Which CyberTipline host receives submissions: "test" (exttest.cybertip.org, nothing is filed for real) or "production" (report.cybertip.org). Writable only through the guarded /admin/safety config endpoint.',
   NULL, NULL, false),
  ('ncmec_report_classifier_hits', 'false', 'boolean', 'NCMEC Report Classifier Hits',
   'Whether classifier-sourced quarantines are filed to NCMEC. Hard-blocked in code until NCMEC answers which incident type applies to a classifier hit — this key alone does not enable it.',
   NULL, NULL, false),
  ('ncmec_backlog_audit_cutoff', '', 'text', 'NCMEC Backlog Audit Cutoff',
   'ISO timestamp bounding the pre-activation backlog audit''s SCOPE, captured before review begins. Reports created at or after it are new-code rows and need no audit. Write-once: moving it would shift the scope of an in-progress audit under the operator.',
   NULL, NULL, false),
  ('ncmec_backlog_audit_completed_at', '', 'text', 'NCMEC Backlog Audit Completed At',
   'ISO timestamp marking the operator''s declaration that the backlog audit is finished. Deliberately separate from the cutoff: the cutoff bounds the work, this records that it was done.',
   NULL, NULL, false),
  ('ncmec_safety_alert_email', '', 'text', 'NCMEC Safety Alert Email',
   'Fallback recipient for submission-failure alerts when no admin has notifications enabled. Not a reserved key — but production activation is refused unless a recipient resolves, and this key cannot be emptied while production is live.',
   NULL, NULL, false),
  ('async_job_ncmec_submit_max_attempts', '8', 'integer', 'NCMEC Submit — Max Attempts',
   'Retry budget for the ncmec_submit queue. With the seeded fourth delay this gives a ~98.6 hour horizon, which is what lets a multi-day CyberTipline outage resolve itself instead of producing a terminal backlog. Lowering it silently shortens that horizon.',
   1, 20, false),
  ('async_job_ncmec_submit_retry_delay_4_ms', '86400000', 'integer', 'NCMEC Submit — 4th Retry Delay (ms)',
   'Delay before the fourth and subsequent retries of an ncmec_submit job (24h). The queue default of 8h would cut the retry horizon to ~10.5 hours while every surface still reported success.',
   60000, 604800000, false)
ON CONFLICT ("key") DO NOTHING;
