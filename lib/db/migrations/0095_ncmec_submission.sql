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

-- Verified, not merely named: a rerun on a database where this constraint was already
-- created by the pre-fix version of this migration (targeting "public".quarantined_memes
-- explicitly) would otherwise find a same-named constraint on conrelid alone and leave it
-- pointing at the wrong (schema-hardcoded) table under any search_path that doesn't put
-- public first — exactly the drift the unqualified REFERENCES above exists to prevent.
DO $$
DECLARE
  con_oid oid;
  correct_relid boolean;
BEGIN
  SELECT c.oid, c.confrelid = to_regclass('quarantined_memes')
    INTO con_oid, correct_relid
    FROM pg_constraint c
   WHERE c.conname = 'ncmec_reports_quarantine_id_fk'
     AND c.conrelid = to_regclass('ncmec_reports');

  IF con_oid IS NOT NULL AND NOT COALESCE(correct_relid, false) THEN
    ALTER TABLE "ncmec_reports" DROP CONSTRAINT "ncmec_reports_quarantine_id_fk";
    con_oid := NULL;
  END IF;

  IF con_oid IS NULL THEN
    ALTER TABLE "ncmec_reports"
      ADD CONSTRAINT "ncmec_reports_quarantine_id_fk"
      FOREIGN KEY ("quarantine_id") REFERENCES "quarantined_memes"("id")
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
-- Scoped by conrelid, not just conname: constraint names are only unique PER RELATION in
-- Postgres, so a same-named CHECK constraint sitting in another schema (this repo's own
-- isolated-test-schema tooling, or a same-named object left in `public`) would satisfy a
-- name-only existence check and this migration would skip adding the constraint to the
-- table it's actually creating — the same class of bug the FK-reconciliation blocks above
-- fix for foreign keys. Verified when present, not just found: `pg_get_constraintdef`'s
-- text is deterministic for a given expression on a given PostgreSQL version, captured
-- directly against this repository's PostgreSQL 16 target rather than hand-composed —
-- Postgres normalizes `IN (...)` to `= ANY (ARRAY[...])` with explicit casts, so a literal
-- reproduction of the source text would never match.
DO $$
DECLARE
  check_def CONSTANT text :=
    'CHECK (((content_origin IS NULL) OR ((content_origin)::text = ANY ((ARRAY[''generated''::character varying, ''user_upload''::character varying, ''stock''::character varying, ''template''::character varying, ''identity''::character varying])::text[]))))';
  con_oid oid;
  con_ok boolean;
BEGIN
  SELECT c.oid, pg_get_constraintdef(c.oid) = check_def AND c.convalidated
    INTO con_oid, con_ok
    FROM pg_constraint c
   WHERE c.conname = 'quarantined_memes_content_origin_check'
     AND c.conrelid = to_regclass('quarantined_memes');
  IF con_oid IS NOT NULL AND NOT COALESCE(con_ok, false) THEN
    ALTER TABLE "quarantined_memes" DROP CONSTRAINT "quarantined_memes_content_origin_check";
    con_oid := NULL;
  END IF;
  IF con_oid IS NULL THEN
    ALTER TABLE "quarantined_memes" ADD CONSTRAINT "quarantined_memes_content_origin_check"
      CHECK ("content_origin" IS NULL OR "content_origin" IN ('generated','user_upload','stock','template','identity'));
  END IF;

  SELECT c.oid, pg_get_constraintdef(c.oid) = check_def AND c.convalidated
    INTO con_oid, con_ok
    FROM pg_constraint c
   WHERE c.conname = 'ncmec_reports_content_origin_check'
     AND c.conrelid = to_regclass('ncmec_reports');
  IF con_oid IS NOT NULL AND NOT COALESCE(con_ok, false) THEN
    ALTER TABLE "ncmec_reports" DROP CONSTRAINT "ncmec_reports_content_origin_check";
    con_oid := NULL;
  END IF;
  IF con_oid IS NULL THEN
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
           -- Bounded to 18 digits, NOT just `^[0-9]+$`. A digit-only value can still
           -- overflow: `'999999999999999999999999'::bigint` raises
           -- numeric_value_out_of_range, which aborts the whole migration — the exact
           -- failure this classification exists to prevent, surviving in the subclass a
           -- shape-only regex lets through. Any 18-digit value is below bigint's
           -- 9223372036854775807 ceiling, and quarantine ids are a bigserial starting at 1,
           -- so this is enormous headroom rather than a real bound.
           CASE WHEN raw_qid IS NULL THEN 'missing'
                WHEN raw_qid !~ '^[0-9]{1,18}$' THEN 'malformed'
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

-- ─── 4b. The backfill is one-shot; the deploy window is not ─────────────────
--
-- 0095 commits before the new code is serving everywhere. During a rolling deploy an OLD
-- instance keeps running the existing `quarantine.ts`, which writes the linkage only into
-- `request_metadata` and knows nothing about `quarantine_id`. Those reports land AFTER the
-- one-shot backfill has already selected its rows, and the partial unique index happily
-- permits their NULL `quarantine_id` — so they would be invisible to the orphan sweep,
-- which would then create a second report for the same hit. Invariant 7 broken by the
-- deploy itself rather than by the back catalogue.
--
-- A repeated reconciliation pass would also close this, but it would leave a window whose
-- width is however long the sweep's cadence is, and it would put the guarantee in
-- application code that only the NEW version runs. A row trigger closes it in the database,
-- for every writer, at insert time — including a writer running code from before this
-- migration existed.
--
-- It is deliberately narrow: it only ever fills a NULL, only from a value that is already
-- range-safe, and only when the referenced quarantine row exists. Everything else is left
-- exactly as the caller wrote it.
CREATE OR REPLACE FUNCTION ncmec_reports_link_quarantine() RETURNS trigger AS $$
DECLARE
  raw text;
BEGIN
  -- An explicit value always wins: the reconciler sets this column directly, and the
  -- trigger must never second-guess a caller that knows the linkage.
  IF NEW.quarantine_id IS NOT NULL THEN RETURN NEW; END IF;

  raw := NEW.request_metadata->>'quarantineId';
  -- Same bounded pattern as the backfill, for the same reason: a digit-only value can
  -- overflow bigint, and an exception here would abort the caller's quarantine transaction.
  IF raw IS NULL OR raw !~ '^[0-9]{1,18}$' THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM quarantined_memes q WHERE q.id = raw::bigint) THEN
    NEW.quarantine_id := raw::bigint;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS ncmec_reports_link_quarantine_trg ON "ncmec_reports";
--> statement-breakpoint
CREATE TRIGGER ncmec_reports_link_quarantine_trg
  BEFORE INSERT ON "ncmec_reports"
  FOR EACH ROW EXECUTE FUNCTION ncmec_reports_link_quarantine();
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
--
-- Verified, not merely named: `CREATE UNIQUE INDEX IF NOT EXISTS` accepts any
-- pre-existing object with this name regardless of its actual definition. A
-- partially recovered or manually drifted database could have a same-named
-- index that is not unique, is on the wrong column, or has no predicate — the
-- constraint that makes concurrent orphan sweeps converge would be silently
-- absent while this migration is recorded as having applied it cleanly. So
-- this inspects pg_index directly (unique, exactly one key column —
-- quarantine_id — and the exact predicate) rather than trusting the name, and
-- only creates the index when none exists yet.
DO $$
DECLARE
  ix_oid oid;
  is_correct boolean;
BEGIN
  -- `to_regclass` on an unqualified name resolves via search_path — exactly how the
  -- CREATE UNIQUE INDEX below (also unqualified) places the object. Hardcoding
  -- `nspname = 'public'` here would look in the wrong schema under any search_path that
  -- doesn't put `public` first — including this repo's own isolated-test schema tooling
  -- (`run-test.sh`, which prepends a disposable schema) — and could match an unrelated
  -- same-named object left over in `public` instead of the one this migration actually
  -- created or needs to create.
  -- Double-quoted inside the string literal: the index was created with a quoted, mixed-case
  -- identifier, and to_regclass folds an unquoted name to lowercase per normal SQL identifier
  -- rules — 'UQ_ncmec_reports_quarantine' alone would look up 'uq_ncmec_reports_quarantine'
  -- and never find it. Verified directly against this repository's PostgreSQL 16 target.
  ix_oid := to_regclass('"UQ_ncmec_reports_quarantine"')::oid;

  IF ix_oid IS NOT NULL THEN
    -- indisvalid matters as much as indisunique: a CREATE UNIQUE INDEX CONCURRENTLY left
    -- half-built by a crashed or cancelled prior attempt can have the right uniqueness flag,
    -- key column and predicate while indisvalid is false — meaning Postgres does not actually
    -- enforce it. indrelid is checked too, so a same-named index that happens to exist on some
    -- OTHER table cannot be mistaken for this one.
    SELECT
      i.indrelid = 'ncmec_reports'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indnkeyatts = 1
      AND i.indkey[0] = (
        SELECT attnum FROM pg_attribute
         WHERE attrelid = i.indrelid AND attname = 'quarantine_id'
      )
      AND pg_get_expr(i.indpred, i.indrelid) = '(quarantine_id IS NOT NULL)'
      INTO is_correct
      FROM pg_index i
     WHERE i.indexrelid = ix_oid;
    -- A same-named relation that is not an index at all (a table, view, etc. left behind by a
    -- drifted recovery) makes this SELECT match zero rows in pg_index, which leaves
    -- is_correct NULL rather than false — and `IF NOT NULL` is NULL, not TRUE, so an
    -- unguarded check here would silently fall through without creating or enforcing
    -- anything. Coalesced explicitly rather than relying on NULL being "handled".
    is_correct := COALESCE(is_correct, false);

    IF NOT is_correct THEN
      RAISE EXCEPTION '0095: an index named "UQ_ncmec_reports_quarantine" already exists but is not the exact unique constraint this migration requires (unique on ncmec_reports(quarantine_id) WHERE quarantine_id IS NOT NULL). This is the constraint that keeps two concurrent orphan sweeps from filing two reports for one quarantine hit; refusing to silently accept a wrong or drifted index. Inspect it with: SELECT indexdef FROM pg_indexes WHERE indexname = ''UQ_ncmec_reports_quarantine''; — then drop it and rerun this migration.';
    END IF;
  ELSE
    CREATE UNIQUE INDEX "UQ_ncmec_reports_quarantine"
      ON "ncmec_reports" ("quarantine_id") WHERE "quarantine_id" IS NOT NULL;
  END IF;
END $$;
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

-- The action vocabulary is closed for the same reason submission_status and content_origin
-- are: this ledger is database-enforced append-only, so a malformed or unknown value written
-- by a future route, migration, or raw SQL statement can never be corrected through ordinary
-- application access afterward, and no consumer of the ledger could reliably classify it.
-- Keep in lockstep with NCMEC_AUDIT_ACTIONS in lib/db/src/schema/moderation.ts.
-- migrations.0095.test.ts asserts the two agree, so the lockstep is enforced rather than
-- remembered.
-- Inspect-then-reconcile rather than an unconditional DROP + ADD, and that is load-bearing for
-- exactly the recovery state the ownership-hardening block below is built to support. Once a
-- DBA has transferred this ledger to `overhype_audit_owner`, the application role no longer
-- owns it — and `ALTER TABLE ... DROP CONSTRAINT` requires ownership, so an unconditional pair
-- of ALTERs here aborts the whole migration before that block ever runs. The hash-based
-- migrator reaches this path whenever migration tracking is lost or 0095's hash changes, which
-- is the same rerun scenario the ownership block's verify-and-continue logic already exists to
-- survive. So: an existing, correct constraint is accepted untouched, and a missing or drifted
-- one is repaired only if this role can actually alter the table — otherwise the exact
-- owner-run commands are reported instead of failing on "must be owner of table".
-- >>> ncmec-0095 action check block (start)
DO $$
DECLARE
  expected  text[] := ARRAY['retry','send_to_test_started','send_to_test_completed','backlog_audit',
                            'approve_identity_omission','mark_manually_filed','correct_manual_filing',
                            'reopen','config_write'];
  con_oid   oid;
  con_def   text;
  ref_def   text;
  con_valid boolean;
  ledger_schema text;
BEGIN
  SELECT n.nspname INTO ledger_schema
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = to_regclass('ncmec_safety_audit_log');
  SELECT c.oid, pg_catalog.pg_get_constraintdef(c.oid)
    INTO con_oid, con_def
    FROM pg_catalog.pg_constraint c
   WHERE c.conname = 'ncmec_safety_audit_log_action_check'
     AND c.conrelid = to_regclass('ncmec_safety_audit_log')
     AND c.contype = 'c';

  IF con_oid IS NOT NULL THEN
    -- Compared against a reference the SAME SERVER renders from the SAME expression, not
    -- against a hardcoded string and not against the set of literals the constraint mentions.
    --
    -- A hardcoded string is version-fragile: pg_get_constraintdef's output carries casts and
    -- parenthesization this migration does not control.
    --
    -- A literal-set comparison is worse in a way that matters more, and is the defect this
    -- replaces: `CHECK (action IN (...) OR true)` and `CHECK (action NOT IN (...))` both
    -- mention exactly the expected literals and both reference the `action` column, so both
    -- were accepted as correct. The first enforces nothing; the second inverts the vocabulary
    -- outright. On a hardened replay the block would then return without touching either —
    -- announcing a boundary it had just declined to verify.
    --
    -- Building the reference on a scratch table sidesteps both problems: identical expression,
    -- identical server, identical renderer, so the two texts are directly comparable and any
    -- semantic difference at all shows up as a difference. The scratch table is temporary and
    -- dropped immediately; `action` is declared with the same type as the real column so the
    -- rendered casts match.
    CREATE TEMP TABLE _ncmec_0095_action_ref ("action" varchar(40));
    EXECUTE $ref$ALTER TABLE _ncmec_0095_action_ref ADD CONSTRAINT _ncmec_0095_action_ref_check
  CHECK ("action" IN ('retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write'))$ref$;
    SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO ref_def
      FROM pg_catalog.pg_constraint c
     WHERE c.conname = '_ncmec_0095_action_ref_check'
       AND c.conrelid = to_regclass('_ncmec_0095_action_ref');
    DROP TABLE _ncmec_0095_action_ref;

    -- convalidated matters alongside the text: a constraint added NOT VALID renders
    -- identically while leaving pre-existing rows unchecked.
    SELECT c.convalidated INTO con_valid
      FROM pg_catalog.pg_constraint c WHERE c.oid = con_oid;

    IF con_def = ref_def AND COALESCE(con_valid, false) THEN
      RAISE NOTICE '0095: ncmec_safety_audit_log_action_check is already present and correct — left untouched, so this migration can be replayed against a ledger whose ownership a DBA has already transferred.';
      RETURN;
    END IF;
  END IF;

  BEGIN
    IF con_oid IS NOT NULL THEN
      EXECUTE 'ALTER TABLE "ncmec_safety_audit_log" DROP CONSTRAINT "ncmec_safety_audit_log_action_check"';
    END IF;
    EXECUTE $stmt$ALTER TABLE "ncmec_safety_audit_log" ADD CONSTRAINT "ncmec_safety_audit_log_action_check"
  CHECK ("action" IN ('retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write'))$stmt$;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Deliberately fatal rather than a warning. Unlike the "already correct" case above, the
    -- constraint genuinely is missing or wrong here, and this ledger is database-enforced
    -- append-only: a row written with an action outside the vocabulary could never afterwards
    -- be corrected through ordinary application access. Finishing quietly would record 0095 as
    -- applied over a ledger that does not actually constrain what it accepts.
    -- `RAISE EXCEPTION '%', format(...)`, never RAISE's own directives. RAISE understands
    -- only bare `%` — it does NOT implement format()'s `%I`/`%L`/`%s`, so writing those here
    -- emits the literal letter (`public` + `I`) and silently corrupts every identifier in the
    -- printed recovery commands. Caught by this block's own regression test, which asserted on
    -- the message text.
    RAISE EXCEPTION '%', format(
      '0095: ncmec_safety_audit_log_action_check is missing or has drifted (found: %s), and this role does not own %I.%I, so it cannot be repaired here. A DBA must run, as the table''s owner: ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS "ncmec_safety_audit_log_action_check"; ALTER TABLE %I.%I ADD CONSTRAINT "ncmec_safety_audit_log_action_check" CHECK ("action" IN (%s));',
      COALESCE(con_def, '<absent>'),
      ledger_schema, 'ncmec_safety_audit_log',
      ledger_schema, 'ncmec_safety_audit_log',
      ledger_schema, 'ncmec_safety_audit_log',
      (SELECT string_agg(quote_literal(v), ',' ORDER BY v) FROM unnest(expected) AS v)
    );
  END;
END $$;
-- <<< ncmec-0095 action check block (end)
--> statement-breakpoint

-- `actor_user_id` carries NO foreign key, deliberately. A FK would make the
-- ledger's contents depend on the users table: an ON DELETE SET NULL would
-- erase the machine-readable half of the attribution when an account is
-- deleted, and any other action would either block the delete or cascade into
-- this table. The actor is denormalized into `actor_label` instead, so deleting
-- the account cannot touch the ledger at all. `report_id` does carry one,
-- because a report row is the thing an entry is ABOUT and its absence is
-- meaningful rather than lossy.
-- Same reconciliation as the quarantine_id FK above: a rerun on a database where this
-- constraint was already created by the pre-fix, schema-hardcoded version must not leave it
-- pointing at the wrong table.
DO $$
DECLARE
  con_oid oid;
  correct_relid boolean;
BEGIN
  SELECT c.oid, c.confrelid = to_regclass('ncmec_reports')
    INTO con_oid, correct_relid
    FROM pg_constraint c
   WHERE c.conname = 'ncmec_safety_audit_log_report_id_fk'
     AND c.conrelid = to_regclass('ncmec_safety_audit_log');

  IF con_oid IS NOT NULL AND NOT COALESCE(correct_relid, false) THEN
    ALTER TABLE "ncmec_safety_audit_log" DROP CONSTRAINT "ncmec_safety_audit_log_report_id_fk";
    con_oid := NULL;
  END IF;

  IF con_oid IS NULL THEN
    ALTER TABLE "ncmec_safety_audit_log"
      ADD CONSTRAINT "ncmec_safety_audit_log_report_id_fk"
      FOREIGN KEY ("report_id") REFERENCES "ncmec_reports"("id")
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
-- **Creating the role also grants it to the creator, and that had to be undone.**
-- On PostgreSQL 16 a role with CREATEROLE that runs `CREATE ROLE x` is automatically
-- granted membership of `x` WITH ADMIN OPTION (`inherit_option = f`, `set_option = f`).
-- Verified directly against this repository's PostgreSQL 16 target:
-- `pg_has_role(creator, x, 'member')` comes back TRUE. So "granted to nobody" would have
-- been false the instant this block succeeded, the trigger would have waved the application
-- role straight through, and no DBA hardening step would have fixed it — the printed
-- instructions transfer ownership, they do not revoke a membership nobody knew existed.
--
-- Two changes close it, and both are needed:
--   1. The automatic grant is revoked here, immediately, using the ADMIN OPTION the
--      creation itself conferred.
--   2. The trigger checks `USAGE`, not `MEMBER`. `MEMBER` is true for any path to the role
--      including one that cannot be exercised; `USAGE` is true only when the session
--      actually holds the role's privileges right now, which is the property the gate is
--      about. A maintenance session reaches it by `SET ROLE`, under which `current_user`
--      *is* the maintenance role and `USAGE` is trivially true.
--
-- Best-effort creation: a deployment whose application role lacks CREATEROLE must not fail
-- its deploy here. The trigger fails CLOSED when the role is absent, so a skipped creation
-- makes the ledger stricter, never looser.
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

  -- Unconditional, not only on the branch that created it: a previous run of this
  -- migration may have created the role and left the automatic grant behind.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'overhype_audit_maintenance')
     AND EXISTS (
       SELECT 1 FROM pg_auth_members m
        WHERE pg_get_userbyid(m.roleid) = 'overhype_audit_maintenance'
          AND pg_get_userbyid(m.member) = current_user
     ) THEN
    BEGIN
      EXECUTE format('REVOKE overhype_audit_maintenance FROM %I', current_user);
      RAISE NOTICE '0095: revoked the automatic creator membership of overhype_audit_maintenance from %', current_user;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING '0095: could NOT revoke overhype_audit_maintenance from % (%). The application role can bypass the append-only trigger until a DBA runs: REVOKE overhype_audit_maintenance FROM that role.', current_user, SQLERRM;
    END;
  END IF;
END $$;
--> statement-breakpoint

-- The audit-log guard objects are created only when the current role is able to. After the
-- DBA hardening step below, `ncmec_safety_audit_log` and this function belong to
-- `overhype_audit_owner`, and an unguarded `CREATE OR REPLACE FUNCTION` would fail with
-- "must be owner of function" on any replay — which is exactly the recovery case where the
-- schema survived but migration tracking did not. When the objects are already in place and
-- this role may not touch them, the migration verifies them and moves on; when they are
-- MISSING and it cannot create them, it fails loudly rather than leaving the ledger
-- unguarded.
-- >>> ncmec-0095 audit guard block (start)
DO $outer$
DECLARE
  -- Captured on entry and restored explicitly at every probe below, instead of RESET ROLE.
  -- RESET ROLE returns the session to `session_user`, NOT to whichever role was current when
  -- this block was entered — verified directly against this repository's PostgreSQL 16 target.
  -- A DBA replaying the migration as the application role (`SET ROLE <app>; \i 0095.sql`)
  -- would otherwise be silently switched to their own login role by the FIRST probe here, and
  -- every ownership check afterwards — including the whole ownership-hardening block further
  -- down, which runs later in the same session — would then be answered for, and grant
  -- against, the wrong role.
  entry_role     text := current_user;
  fn_owner       oid;
  tbl_owner      oid;
  can_fn         boolean := false;
  can_tbl        boolean := false;
  trg_count      int;
  fn_intact      boolean;
  -- The function body, held ONCE and referenced by both the CREATE OR REPLACE below and the
  -- fallback verification further down. A prior version compared prosrc against a few
  -- substrings the gate's logic depends on (the role name, 'usage', RAISE EXCEPTION) — but a
  -- permissive replacement can keep all three present while making the original body
  -- unreachable, e.g. by prepending an unconditional `RETURN NEW;` before it. Comparing the
  -- FULL text closes that gap, and driving both the create and the verify from one variable
  -- means there is only ever one copy to keep in sync — a hand-duplicated second copy would
  -- drift the moment either one was edited without the other.
  --
  -- pg_roles/pg_has_role below are schema-qualified as pg_catalog.pg_roles/
  -- pg_catalog.pg_has_role, kept byte-identical to lib/db/src/index.ts's
  -- NCMEC_AUDIT_LOG_GUARD_FN_BODY (see that constant's doc comment for why: this function has
  -- no SECURITY DEFINER and no SET search_path, so an unqualified reference resolves via
  -- whatever search_path the CALLING session set — and a role with CREATE on any schema it can
  -- reach can shadow pg_roles/pg_has_role with its own objects to defeat this exact check.
  -- Verified directly against this repository's PostgreSQL 16 target: the unqualified form let
  -- an UPDATE through a shadowed session succeed outright).
  fn_body CONSTANT text := $body_src$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'overhype_audit_maintenance')
     OR NOT pg_catalog.pg_has_role(current_user, 'overhype_audit_maintenance', 'usage') THEN
    RAISE EXCEPTION 'ncmec_safety_audit_log is append-only (%)', TG_OP
      USING HINT = 'An effective grant of overhype_audit_maintenance is required to modify this ledger.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$body_src$;
BEGIN
  -- Unqualified `to_regprocedure`/`to_regclass` resolve via search_path — the same path the
  -- (also unqualified) CREATE statements in this migration used to place these objects.
  -- Hardcoding `nspname = 'public'` here would look in the wrong schema under any
  -- search_path that doesn't put `public` first, including this repo's own isolated-test
  -- schema tooling.
  SELECT proowner INTO fn_owner
    FROM pg_proc WHERE oid = to_regprocedure('ncmec_safety_audit_log_append_only()');
  SELECT relowner INTO tbl_owner
    FROM pg_class WHERE oid = to_regclass('ncmec_safety_audit_log');

  -- Can this role actually BECOME the owner via SET ROLE? `pg_has_role(..., 'usage')`
  -- is NOT this question — verified directly against this repository's PostgreSQL 16
  -- target: a role granted membership with INHERIT FALSE, SET TRUE reports
  -- `usage = false` (correctly — the owner's privileges are not automatically available)
  -- while `SET ROLE` to it still succeeds and hands over its full privileges, including
  -- `ALTER TABLE ... DISABLE TRIGGER`. `usage` alone would have under-reported capability
  -- here — the opposite direction from a security bug, but it also means a role that
  -- genuinely can complete the hardening step (SET-only, no INHERIT) would have been
  -- wrongly told it cannot, and would fall through to the exception branch below on a
  -- database it could actually service. Tested by attempting the SET, not by asking a
  -- catalog function that does not answer this question. If the object does not exist
  -- yet, or this session already IS the owner, no role switch is needed at all.
  IF fn_owner IS NULL OR fn_owner = to_regrole(current_user) THEN
    can_fn := true;
  ELSE
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', pg_get_userbyid(fn_owner));
      can_fn := true;
    EXCEPTION WHEN OTHERS THEN
      can_fn := false;
    END;
    EXECUTE format('SET LOCAL ROLE %I', entry_role);
  END IF;

  IF tbl_owner IS NOT NULL AND tbl_owner = to_regrole(current_user) THEN
    can_tbl := true;
  ELSIF tbl_owner IS NOT NULL THEN
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', pg_get_userbyid(tbl_owner));
      can_tbl := true;
    EXCEPTION WHEN OTHERS THEN
      can_tbl := false;
    END;
    EXECUTE format('SET LOCAL ROLE %I', entry_role);
  END IF;

  IF can_fn THEN
    IF fn_owner IS NOT NULL AND fn_owner <> to_regrole(current_user) THEN
      EXECUTE format('SET LOCAL ROLE %I', pg_get_userbyid(fn_owner));
    END IF;
    -- The EXISTS guard inside fn_body is not defensive noise: pg_has_role RAISES on a role
    -- that does not exist, so without it a deployment that could not create the role would
    -- block every operation with a confusing "role does not exist" error instead of this
    -- one. Fails closed either way; this fails closed legibly.
    --
    -- 'usage' inside fn_body is deliberate and correct, unlike the migration-guard's own use
    -- above: this predicate decides whether an ordinary application statement should be let
    -- through, and an ordinary statement runs with whatever the session's INHERITED
    -- privileges already are — it never issues its own SET ROLE. A maintenance session that
    -- reaches this point via SET ROLE has current_user *equal to* the maintenance role,
    -- under which 'usage' is trivially true; a session that only *could* SET ROLE but has
    -- not is correctly still blocked here, exactly as it should be until it actually assumes
    -- the role. RETURN NULL on the DELETE path would silently CANCEL the operation — in a
    -- BEFORE row trigger a NULL return cancels it — the exact opposite of what the escape
    -- hatch is for: failing closed while appearing to succeed.
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION ncmec_safety_audit_log_append_only() RETURNS trigger AS %L LANGUAGE plpgsql',
      fn_body
    );
    EXECUTE format('SET LOCAL ROLE %I', entry_role);
  END IF;

  IF can_tbl THEN
    IF tbl_owner IS NOT NULL AND tbl_owner <> to_regrole(current_user) THEN
      EXECUTE format('SET LOCAL ROLE %I', pg_get_userbyid(tbl_owner));
    END IF;
    -- DROP IF EXISTS before each CREATE, because this migration is required to be
    -- rerunnable and an unguarded CREATE TRIGGER fails on the second pass.
    EXECUTE 'DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_mutate ON "ncmec_safety_audit_log"';
    EXECUTE 'CREATE TRIGGER ncmec_safety_audit_log_no_mutate
               BEFORE UPDATE OR DELETE ON "ncmec_safety_audit_log"
               FOR EACH ROW EXECUTE FUNCTION ncmec_safety_audit_log_append_only()';
    -- ENABLE ALWAYS, not the default origin-only firing: verified directly against this
    -- repository's PostgreSQL 16 target that a role holding `GRANT SET ON PARAMETER
    -- session_replication_role` (a real, grantable PostgreSQL 15+ privilege, independent of
    -- table/function ownership) can run `SET session_replication_role = replica` in its own
    -- session and have an origin-enabled ('O') trigger simply not fire — UPDATE/DELETE/
    -- TRUNCATE went through uncaught in that reproduction. ALWAYS-enabled triggers fire
    -- regardless of session_replication_role, closing that path entirely. The one trade-off:
    -- an ALWAYS trigger also fires during logical replication apply, which is not a concern
    -- this database's setup exercises today, but is worth knowing if that ever changes.
    EXECUTE 'ALTER TABLE "ncmec_safety_audit_log" ENABLE ALWAYS TRIGGER ncmec_safety_audit_log_no_mutate';
    -- TRUNCATE is covered too, by a STATEMENT-level trigger sharing the same gate. A row
    -- trigger does not fire on TRUNCATE, so leaving it out would let the application role
    -- erase the entire ledger with one statement — on the table that is the sole control
    -- over destructive admin actions.
    EXECUTE 'DROP TRIGGER IF EXISTS ncmec_safety_audit_log_no_truncate ON "ncmec_safety_audit_log"';
    EXECUTE 'CREATE TRIGGER ncmec_safety_audit_log_no_truncate
               BEFORE TRUNCATE ON "ncmec_safety_audit_log"
               FOR EACH STATEMENT EXECUTE FUNCTION ncmec_safety_audit_log_append_only()';
    EXECUTE 'ALTER TABLE "ncmec_safety_audit_log" ENABLE ALWAYS TRIGGER ncmec_safety_audit_log_no_truncate';
    EXECUTE format('SET LOCAL ROLE %I', entry_role);
  ELSE
    -- Verified with the SAME rigor as ncmecAuditBoundaryStatus() (lib/db/src/index.ts) —
    -- name and tgenabled alone are not enough. A same-named trigger recreated wrong during
    -- a hardening step (wrong function, wrong events, or left REPLICA-only) would satisfy a
    -- name+enabled check while leaving the ledger genuinely unguarded, and this branch is
    -- the one case where the migration cannot fall back on creating the real thing itself.
    SELECT count(*) INTO trg_count
      FROM pg_trigger t
     WHERE t.tgrelid = 'ncmec_safety_audit_log'::regclass
       AND t.tgname IN ('ncmec_safety_audit_log_no_mutate', 'ncmec_safety_audit_log_no_truncate')
       -- 'A' (ALWAYS) only, not 'O' (origin) — a role holding GRANT SET ON PARAMETER
       -- session_replication_role can disable an origin-only trigger for its own session by
       -- SET session_replication_role = replica; ALWAYS is immune to that. A same-named
       -- trigger left origin-only by an older hardened database (or a drifted recovery) is
       -- exactly the state this branch must refuse to accept as sufficient.
       AND t.tgenabled = 'A'
       AND t.tgfoid = to_regprocedure('ncmec_safety_audit_log_append_only()')
       -- tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE.
       -- EXACT equality, not "these bits are set": a recovered trigger recreated with an
       -- EXTRA event (e.g. BEFORE INSERT OR UPDATE OR DELETE, adding INSERT to no_mutate)
       -- would satisfy a subset check while gating every ordinary audit-log append behind
       -- the maintenance role too — silently breaking normal appends while this check keeps
       -- reporting the boundary correctly wired. 27 = ROW(1)+BEFORE(2)+DELETE(8)+UPDATE(16);
       -- 34 = BEFORE(2)+TRUNCATE(32). Verified against this repository's PostgreSQL 16
       -- target rather than computed by hand alone.
       AND t.tgtype = CASE t.tgname
             WHEN 'ncmec_safety_audit_log_no_mutate' THEN 27
             ELSE 34
           END;

    -- tgfoid alone is not proof the FUNCTION still implements the gate: `CREATE OR REPLACE
    -- FUNCTION` preserves the same oid even when the body underneath is swapped for something
    -- permissive, which is exactly the recovery-database scenario this branch exists for — an
    -- oid match would accept a same-named, same-signature function that lets everything
    -- through. Compared against fn_body — the SAME text the create branch above uses — rather
    -- than substring markers: a permissive replacement could keep every marker substring
    -- present while making the original body unreachable (e.g. prepending an unconditional
    -- RETURN NEW;), so only an exact match proves the deployed function is this one. prosecdef
    -- must also be false: inside a SECURITY DEFINER function, current_user resolves to the
    -- FUNCTION OWNER for the duration of the call, not the actual caller (verified directly
    -- against this repository's PostgreSQL 16 target) — so a byte-identical body marked
    -- SECURITY DEFINER and owned by a role that itself holds overhype_audit_maintenance would
    -- pass the guard's own pg_has_role(current_user, ...) check for EVERY caller regardless of
    -- their real privileges, while prosrc alone still reads as untampered.
    SELECT prosrc = fn_body AND NOT prosecdef INTO fn_intact
      FROM pg_proc
     WHERE oid = to_regprocedure('ncmec_safety_audit_log_append_only()');

    IF trg_count = 2 AND COALESCE(fn_intact, false) THEN
      RAISE NOTICE '0095: ncmec_safety_audit_log is owned by another role, both append-only triggers are already present, enabled and correctly wired, and the guard function''s source still implements the check — leaving them alone.';
    ELSE
      RAISE EXCEPTION '0095: ncmec_safety_audit_log is owned by a role this session cannot assume, and either the append-only triggers are not both present/origin-enabled/correctly wired, or the guard function they call no longer appears to implement the check. A DBA must recreate them as the owner; refusing to leave the ledger unguarded.';
    END IF;
  END IF;
END $outer$;
-- <<< ncmec-0095 audit guard block (end)
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
-- >>> ncmec-0095 ownership hardening block (start)
--
-- Mirrors lib/db/src/index.ts's canEffectivelyAssumeRole (usage, SET ROLE, or admin option —
-- including a further, nested admin option — checked recursively through admin-option
-- grantees), but this migration cannot literally share that TypeScript code, so this is a
-- PL/pgSQL reimplementation. Scoped to pg_temp deliberately: it exists only to answer "can
-- THIS migration-running session effectively become role X" for the DBA-facing status
-- messages below, not as a persistent part of the schema, so it lives in the session-local,
-- auto-dropped pg_temp schema rather than becoming a permanent database object. Every
-- catalog reference inside is pg_catalog-qualified for the same reason the runtime version
-- is: a session that controls its own search_path could otherwise shadow pg_has_role to
-- misreport its own effective access (see lib/db/src/index.ts's canEffectivelyAssumeRole
-- doc comment). Used below in place of the earlier SET-ROLE-attempt-only checks, which
-- missed INHERIT-only and ADMIN-only grant shapes the same way canAssumeRole alone did
-- before canEffectivelyAssumeRole existed.
-- Can role `subject` effectively BECOME role `target`? Pure catalog reads — no role
-- mutation at all, which is a deliberate change from the earlier version: this is asked
-- recursively, and a recursive function that issues SET ROLE has to get the restore right at
-- every level (see the RESET ROLE hazard documented on ncmec_can_set_role below). Verified
-- directly against this repository's PostgreSQL 16 target that `pg_has_role(..., 'set')`
-- answers the SET-ROLE question exactly, so the probe was never necessary here.
--
-- The predicate is `usage OR set OR admin-option-chain`, and each disjunct is load-bearing:
--
--   usage  — INHERIT membership: the target's privileges are ambiently available.
--   set    — SET-ROLE membership: assumable on demand.
--   admin  — the subject can reach some role holding ADMIN OPTION on the target, and can
--            therefore grant the target to itself whenever it likes.
--
-- `member` is deliberately NOT used, though it looks like the obvious primitive. Verified
-- directly: an `INHERIT FALSE, SET FALSE` grant reports member = true while usage and set are
-- both false — membership the holder cannot actually exercise. Using `member` would report a
-- bypass that does not exist and, through the activation gate, block production on a boundary
-- that is in fact closed.
CREATE OR REPLACE FUNCTION pg_temp.ncmec_role_reaches(
  subject text,
  target  text,
  visited text[] DEFAULT ARRAY[]::text[]
) RETURNS boolean AS $role_reaches$
DECLARE
  admin_holder text;
BEGIN
  IF subject = target THEN RETURN true; END IF;
  IF target = ANY(visited) THEN RETURN false; END IF;
  visited := visited || target;

  IF pg_catalog.pg_has_role(subject, target, 'usage')
     OR pg_catalog.pg_has_role(subject, target, 'set') THEN
    RETURN true;
  END IF;

  FOR admin_holder IN
    SELECT pg_catalog.pg_get_userbyid(m.member)
      FROM pg_catalog.pg_auth_members m
     WHERE pg_catalog.pg_get_userbyid(m.roleid) = target
       AND m.admin_option
  LOOP
    IF pg_temp.ncmec_role_reaches(subject, admin_holder, visited) THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$role_reaches$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The roles granted DIRECTLY to the invoking role — real `pg_auth_members` rows with
-- `member = current_user` — from which `target` is reachable. Each one is therefore a grant a
-- DBA can actually revoke, and revoking all of them severs every path the application has.
--
-- Returning direct edges rather than a reachability chain is the correction to the previous
-- version. That one returned `ARRAY[target]` as soon as `pg_has_role(current_user, target,
-- 'usage')` was true — but that function is TRANSITIVE, so a true answer does not mean a
-- direct grant exists. With the application a member of an intermediate role that is itself a
-- member of the target (or of an ADMIN OPTION holder), the guidance emitted
-- `REVOKE <target> FROM <app>` for a grant that was never there: it succeeds, changes nothing,
-- and the next rerun prints it again — the exact loop the path was introduced to escape,
-- surviving one level further out.
--
-- Empty (not NULL) when the target is unreachable, and empty ALSO when it is reachable only
-- through something other than a direct grant to the application — a role the application logs
-- in as by another mechanism, say. Callers must treat "reachable but no revocable edge" as a
-- state needing a human, never as "nothing to do": ncmec_role_reaches stays the authority on
-- WHETHER a bypass exists, and this function only answers HOW to cut it.
CREATE OR REPLACE FUNCTION pg_temp.ncmec_revocable_edges(target text) RETURNS text[] AS $rev_edges$
  SELECT COALESCE(array_agg(DISTINCT edge ORDER BY edge), ARRAY[]::text[])
    FROM (
      SELECT pg_catalog.pg_get_userbyid(m.roleid) AS edge
        FROM pg_catalog.pg_auth_members m
       WHERE m.member = pg_catalog.to_regrole(current_user)
    ) direct
   WHERE pg_temp.ncmec_role_reaches(direct.edge, target);
$rev_edges$ LANGUAGE sql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.ncmec_can_effectively_assume(role_name text) RETURNS boolean AS $can_assume$
  SELECT pg_temp.ncmec_role_reaches(current_user, role_name);
$can_assume$ LANGUAGE sql;
--> statement-breakpoint
-- Deliberately NARROWER than ncmec_can_effectively_assume: whether this role can literally
-- `SET ROLE` to `role_name` right now, with no inheritance path and no admin-option reasoning.
--
-- The two answer different questions and both are needed. Effective assumption is the SECURITY
-- question — can the application reach a role that lets it bypass the append-only guarantee —
-- and it is deliberately generous. Whether this migration can itself perform the ownership
-- TRANSFER is a narrower CAPABILITY question: `ALTER TABLE ... OWNER TO` fails with "must be
-- able to SET ROLE" without SET access, and the subsequent `SET LOCAL ROLE` obviously does
-- too. Verified directly against this repository's PostgreSQL 16 target that an
-- `INHERIT TRUE, SET FALSE` grant reports pg_has_role(...,'usage') = true while BOTH of those
-- statements fail — so gating the transfer on the security predicate would abort the migration
-- outright on precisely the grant shapes the broader check was widened to recognize, instead of
-- falling through to the DBA guidance that can actually resolve them.
CREATE OR REPLACE FUNCTION pg_temp.ncmec_can_set_role(role_name text) RETURNS boolean AS $can_set_role$
DECLARE
  prior_role text := current_user;  -- same RESET ROLE hazard as above
  ok         boolean := false;
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    ok := true;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  EXECUTE format('SET LOCAL ROLE %I', prior_role);
  RETURN ok;
END;
$can_set_role$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
DECLARE
  app_role          text := current_user;
  -- The SECURITY question: can the application reach overhype_audit_owner by ANY effective
  -- route (inheritance, SET ROLE, or an admin-option chain)? Governs every claim this block
  -- makes about whether the boundary is closed.
  can_own           boolean := false;
  -- The CAPABILITY question, and deliberately not the same one: can this session literally
  -- SET ROLE to overhype_audit_owner? Only this one may gate the transfer branch below.
  -- `ALTER TABLE ... OWNER TO` fails with "must be able to SET ROLE" and the branch's own
  -- `SET LOCAL ROLE` fails outright without it, so gating the transfer on `can_own` aborted
  -- the migration on exactly the INHERIT-only and admin-option grant shapes that check was
  -- widened to detect — instead of leaving them to the DBA guidance that can resolve them.
  can_set_own       boolean := false;
  -- The DIRECT grants (see pg_temp.ncmec_revocable_edges) through which the application
  -- reaches overhype_audit_owner. Each is a real pg_auth_members row a DBA can revoke; for an
  -- admin-option or transitive chain none of them is overhype_audit_owner itself, and telling
  -- a DBA to revoke THAT would be a no-op they could repeat forever.
  owner_edges       text[];
  -- The append-only triggers gate on an effective grant of overhype_audit_maintenance, so
  -- reaching that role bypasses the ledger just as owning the table does — and the earlier
  -- maintenance block revokes only a DIRECT membership. Checked with the same reachability
  -- predicate as the owner role, and folded into every completion claim below: without it this
  -- block could announce "fully hardened" while ncmecAuditBoundaryStatus() correctly reports
  -- applicationCanBypassTrigger and the activation gate keeps refusing production — two
  -- implementations of one question disagreeing, with this one being the optimistic side.
  can_maintenance   boolean := false;
  maintenance_edges text[];
  -- The REVOKE that actually breaks `owner_path`, rendered once and reused by every branch
  -- that has to tell a DBA how to finish. Built from the path rather than hardcoded, which is
  -- the whole point of resolving the path at all.
  revoke_hint       text;
  maintenance_hint  text;
  maintenance_note  text := '';
  owner_role_exists boolean := false;
  tbl_done          boolean;
  fn_done           boolean;
  grants_done       boolean;
  -- Resolved once, used only in the printed DBA instructions below. Hardcoding "public"
  -- there was wrong under this repo's own isolated-test-schema tooling, and would be wrong
  -- for any real deployment whose search_path doesn't put public first: PostgreSQL requires
  -- the NEW owner to hold CREATE on the SCHEMA THE TABLE ACTUALLY LIVES IN, not on public
  -- specifically — a DBA following a hardcoded "public" instruction to the letter on such a
  -- database would still hit "permission denied for schema <real schema>" on the transfer.
  ledger_schema     text;
  -- The role that owns ledger_schema itself, and whether the application can become it —
  -- checked with the SAME technique as overhype_audit_owner below, and independently of
  -- table/function ownership. Transferring the TABLE and FUNCTION alone does not close the
  -- boundary if the application (or a role it can become) still effectively owns the
  -- CONTAINING SCHEMA: a schema owner can DROP TABLE/DROP FUNCTION any object inside it
  -- regardless of that object's own relowner/proowner. Verified directly against this
  -- repository's PostgreSQL 16 target. This matters even on a totally default deployment:
  -- PostgreSQL 15+ makes `public`'s owner the `pg_database_owner` pseudo-role, which
  -- automatically includes the database's actual owner as an implicit member — so the
  -- application effectively owns `public` (and can `SET ROLE pg_database_owner`, verified
  -- directly) whenever it also happens to be the database owner, with no explicit grant at
  -- all. This block cannot reconcile schema ownership the way it reconciles table/function
  -- ownership — there is no per-schema equivalent of "transfer to overhype_audit_owner" for
  -- `public` specifically, short of either changing the DATABASE's own owner (a
  -- cluster-level operation far outside migration scope) or moving the ledger into a
  -- dedicated schema (a structural change this migration does not make) — so the fix here is
  -- detection and DBA guidance, not automatic remediation.
  schema_owner_role text;
  can_own_schema    boolean := false;
  -- The guard FUNCTION's own containing schema, checked independently of ledger_schema —
  -- mirrors lib/db/src/index.ts's functionSchemaOwner/applicationOwnsFunctionSchema. Both
  -- land in the same schema today (both are created via unqualified statements resolving
  -- through the same search_path), but nothing pins that relationship: a DBA who later moved
  -- just the function to a different schema (ALTER FUNCTION ... SET SCHEMA) would leave a
  -- schema owner of THAT schema free to DROP FUNCTION ... CASCADE (dropping both dependent
  -- triggers too) regardless of the function's own proowner — the runtime status already
  -- catches this independently, so this migration's own guidance must not fall out of sync
  -- with it.
  function_schema            text;
  function_schema_owner_role text;
  can_own_function_schema    boolean := false;
  recovery_cmds     text;
  -- Accumulates whatever remains open (owner-role revocation, schema ownership, function-
  -- schema ownership) for the branches that need to describe a PARTIAL bypass rather than
  -- either full success or the single "still fully application-owned" case the final ELSE
  -- branch already covers.
  boundary_note     text;
BEGIN
  SELECT n.nspname INTO ledger_schema
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = to_regclass('ncmec_safety_audit_log');
  SELECT n2.nspname INTO function_schema
    FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
   WHERE p.oid = to_regprocedure('ncmec_safety_audit_log_append_only()');

  -- Same defect, same fix as the rerun guard above used to have: `usage` alone answers only
  -- whether a role's privileges are INHERITED, not whether this role can effectively become
  -- it — and completing the transfer, or recognizing that it's already unassumable, requires
  -- the fuller usage/SET-ROLE/admin-option union pg_temp.ncmec_can_effectively_assume
  -- implements above. Round 10 finding: the previous SET-ROLE-attempt-only version here
  -- missed INHERIT-only and ADMIN-only grant shapes, the same class of gap
  -- canEffectivelyAssumeRole was written to close on the runtime side.
  owner_role_exists := EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'overhype_audit_owner');
  IF owner_role_exists THEN
    can_own     := pg_temp.ncmec_can_effectively_assume('overhype_audit_owner');
    owner_edges := pg_temp.ncmec_revocable_edges('overhype_audit_owner');
    -- Asked separately, never derived from can_own — see both declarations above.
    can_set_own := pg_temp.ncmec_can_set_role('overhype_audit_owner');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'overhype_audit_maintenance') THEN
    can_maintenance   := pg_temp.ncmec_can_effectively_assume('overhype_audit_maintenance');
    maintenance_edges := pg_temp.ncmec_revocable_edges('overhype_audit_maintenance');
  END IF;

  -- `owner_edges` naming exactly overhype_audit_owner is the ordinary case: the application
  -- holds it directly and revoking that is precisely right. Anything else is the case this
  -- exists for — the application reaches it through OTHER roles it holds (transitively, or via
  -- an ADMIN OPTION holder that can re-grant at will), so `REVOKE overhype_audit_owner FROM
  -- <app>` removes a membership that was never there: it succeeds, changes nothing, and leaves
  -- 0095 emitting this same warning on every subsequent rerun.
  --
  -- Every edge is listed, not just one. Severing a single path when several exist would leave
  -- the boundary open while looking resolved on the next rerun's first check.
  IF can_own THEN
    IF owner_edges = ARRAY['overhype_audit_owner'] THEN
      revoke_hint := format('REVOKE overhype_audit_owner FROM %I;', app_role);
    ELSIF COALESCE(array_length(owner_edges, 1), 0) > 0 THEN
      revoke_hint := (
        SELECT string_agg(format('REVOKE %I FROM %I;', e, app_role), ' ' ORDER BY e)
          FROM unnest(owner_edges) AS e
      ) || format(
        ' (the application does NOT hold overhype_audit_owner directly — it reaches it through the role(s) above, each of which either carries ADMIN OPTION on it or leads to a role that does, so revoking overhype_audit_owner from %I would change nothing.)',
        app_role);
    ELSE
      -- Reachable, but through nothing this role holds by a direct grant — so there is no
      -- command this migration can name. Said plainly rather than omitted: silence here would
      -- read as "no action needed" on a database whose boundary is genuinely open.
      revoke_hint := format(
        '-- MANUAL: the application (%I) can reach overhype_audit_owner, but through no grant held directly by it, so no single REVOKE can be named here. Inspect with: SELECT roleid::regrole, member::regrole, admin_option FROM pg_auth_members;',
        app_role);
    END IF;
  END IF;

  -- The same treatment for the maintenance role, whose reachability bypasses the append-only
  -- triggers outright — the guard function admits any caller with an effective grant of it.
  IF can_maintenance THEN
    IF COALESCE(array_length(maintenance_edges, 1), 0) > 0 THEN
      maintenance_hint := (
        SELECT string_agg(format('REVOKE %I FROM %I;', e, app_role), ' ' ORDER BY e)
          FROM unnest(maintenance_edges) AS e
      );
    ELSE
      maintenance_hint := format(
        '-- MANUAL: the application (%I) can reach overhype_audit_maintenance through no directly-held grant; inspect pg_auth_members.',
        app_role);
    END IF;
    maintenance_note :=
      ' The application can still effectively assume overhype_audit_maintenance, which the append-only triggers accept as authorization to UPDATE, DELETE or TRUNCATE the ledger — so the guarantee is bypassable regardless of who owns the table. To close it: '
      || maintenance_hint;
  END IF;

  SELECT pg_get_userbyid(n.nspowner) INTO schema_owner_role
    FROM pg_namespace n WHERE n.nspname = ledger_schema;
  IF schema_owner_role IS NOT NULL THEN
    can_own_schema := pg_temp.ncmec_can_effectively_assume(schema_owner_role);
  END IF;

  SELECT pg_get_userbyid(n2.nspowner) INTO function_schema_owner_role
    FROM pg_namespace n2 WHERE n2.nspname = function_schema;
  IF function_schema_owner_role IS NOT NULL THEN
    can_own_function_schema := pg_temp.ncmec_can_effectively_assume(function_schema_owner_role);
  END IF;

  -- Each of the three things this block is responsible for — table ownership, function
  -- ownership, and the two application grants — is checked INDEPENDENTLY, not inferred from
  -- table ownership alone. A DBA sequence interrupted after `ALTER TABLE ... OWNER TO` but
  -- before the function transfer and the GRANTs would otherwise read as "already done" on
  -- the next rerun: the application permanently short of its SELECT/INSERT grants, the guard
  -- function possibly still application-owned, and ncmecAuditBoundaryStatus() free to report
  -- the boundary enforced on a database that was never actually finished hardening.
  -- Unqualified `to_regclass`/`to_regprocedure` resolve via search_path, the same path this
  -- migration's own (also unqualified) statements used to place these objects — hardcoding
  -- `nspname = 'public'` here would look in the wrong schema under any search_path that
  -- doesn't put `public` first.
  SELECT pg_get_userbyid(relowner) = 'overhype_audit_owner' INTO tbl_done
    FROM pg_class WHERE oid = to_regclass('ncmec_safety_audit_log');
  tbl_done := COALESCE(tbl_done, false);

  SELECT pg_get_userbyid(proowner) = 'overhype_audit_owner' INTO fn_done
    FROM pg_proc WHERE oid = to_regprocedure('ncmec_safety_audit_log_append_only()');
  fn_done := COALESCE(fn_done, false);

  -- has_table_privilege()/has_sequence_privilege() answer "does app_role have this privilege
  -- right now", which is exactly wrong here: on the very first hardening run app_role still
  -- OWNS both objects, so both would report true before a single explicit GRANT has ever been
  -- issued. That stale true then skips the GRANT block below, and once ownership moves to
  -- overhype_audit_owner the application is left with nothing durable — masked only for as
  -- long as it still inherits overhype_audit_owner's membership, until the DBA runs the
  -- (non-optional) REVOKE. aclexplode() reads the literal ACL entries instead — but is only a
  -- RELIABLE signal for app_role once app_role is confirmed NOT to be the current owner
  -- (tbl_done): verified directly against this repository's PostgreSQL 16 target that once an
  -- object's ACL is non-NULL for any reason (its own history, not just this block), `ALTER
  -- ... OWNER TO` materializes the NEW owner's full implicit privilege set as an EXPLICIT ACL
  -- entry — indistinguishable, from aclexplode() alone, from a genuinely narrow explicit
  -- GRANT. So this value is used ONLY for the "already fully done, nothing to do" fast path
  -- below (safe: reachable only when tbl_done/fn_done are already true, at which point
  -- app_role cannot be the owner and any entry naming it is necessarily a real grant) — never
  -- to gate whether the GRANT statements themselves run, which are unconditional and
  -- idempotent instead.
  grants_done :=
    EXISTS (SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = to_regclass('ncmec_safety_audit_log'))) a
             WHERE a.grantee = to_regrole(app_role) AND a.privilege_type = 'SELECT')
    AND EXISTS (SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = to_regclass('ncmec_safety_audit_log'))) a
             WHERE a.grantee = to_regrole(app_role) AND a.privilege_type = 'INSERT')
    AND EXISTS (SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = to_regclass('ncmec_safety_audit_log_id_seq'))) a
             WHERE a.grantee = to_regrole(app_role) AND a.privilege_type = 'USAGE')
    AND EXISTS (SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = to_regclass('ncmec_safety_audit_log_id_seq'))) a
             WHERE a.grantee = to_regrole(app_role) AND a.privilege_type = 'SELECT');

  IF tbl_done AND fn_done AND grants_done
     AND NOT can_own_schema AND NOT can_own_function_schema AND NOT can_own
     AND NOT can_maintenance THEN
    RAISE NOTICE '0095: ncmec_safety_audit_log is already fully hardened — owned by overhype_audit_owner, with the application role''s grants in place, and neither the containing schema, the guard function''s own schema, nor overhype_audit_owner itself is assumable by the application, and the application cannot assume overhype_audit_maintenance either.';
  ELSIF tbl_done AND fn_done AND grants_done THEN
    -- Table ownership, function ownership, and the application's grants are all correctly
    -- done — but at least one of three things is still true: the application can become
    -- overhype_audit_owner itself (the final REVOKE was never run), the ledger's containing
    -- schema is still assumable, or the guard function's own containing schema (if it
    -- differs from the ledger's) is still assumable. Any one of these lets the application
    -- disable the triggers or drop-and-recreate the ledger/guard regardless of who owns them
    -- individually; ncmecAuditBoundaryStatus().boundaryEnforced correctly stays false in
    -- this state, and this migration must not claim hardening complete over it.
    boundary_note := '';
    IF can_own THEN
      boundary_note := boundary_note
        || ' The application can still become overhype_audit_owner itself — the final revocation has not been run. As a role with ADMIN OPTION on it: ' || revoke_hint;
    END IF;
    IF can_own_schema THEN
      boundary_note := boundary_note
        || ' The containing schema (' || quote_ident(ledger_schema) || ') is owned by ' || quote_ident(schema_owner_role)
        || ', a role the application can also become — this migration cannot reconcile schema ownership automatically (see this block''s other branches for what closing it requires).';
    END IF;
    IF can_own_function_schema AND function_schema IS DISTINCT FROM ledger_schema THEN
      boundary_note := boundary_note
        || ' The guard function''s own containing schema (' || quote_ident(function_schema) || ') is owned by ' || quote_ident(function_schema_owner_role)
        || ', a role the application can also become — the same reconciliation gap applies to it independently of the table''s schema.';
    END IF;
    boundary_note := boundary_note || maintenance_note;
    RAISE WARNING '0095: ncmec_safety_audit_log, its guard function, and the application''s grants are all correctly hardened, but the application can still bypass the append-only guarantee through a role it can become.%', boundary_note;
  ELSIF can_set_own THEN
    -- `can_set_own`, NOT `can_own`. Both statements this branch opens with require the ability
    -- to SET ROLE to overhype_audit_owner specifically: `ALTER TABLE ... OWNER TO` fails with
    -- "must be able to SET ROLE" without it, and the `SET LOCAL ROLE` below fails outright.
    -- `can_own` is deliberately broader — it also counts INHERIT-only membership and
    -- admin-option chains, neither of which can execute either statement — so entering here on
    -- `can_own` aborted the entire migration on precisely the grant shapes the effective-access
    -- check was widened to recognize. Those now fall through to the DBA recovery branch below,
    -- which can actually describe how to resolve them.
    --
    -- The OWNER TO statements must run as the CURRENT owner (app_role, no role switch) —
    -- Postgres's special-case rule for ALTER ... OWNER TO lets an owning role with only
    -- SET-capability (no INHERIT) on the target reassign ownership directly, but the
    -- executing role still has to actually own the object being altered. Only ONCE both
    -- objects belong to overhype_audit_owner do the GRANTs below need to run AS it: if
    -- app_role has SET but not INHERIT on overhype_audit_owner — the exact grant shape the
    -- SET ROLE fix above exists to accept — its ambient privileges do not extend to an
    -- object it just gave away, and an unguarded GRANT here fails with "permission denied
    -- for table ncmec_safety_audit_log". Verified directly against this repository's
    -- PostgreSQL 16 target while adding test coverage for this block: switching role BEFORE
    -- the OWNER TO statements instead fails with "must be owner of table" — that ordering
    -- is not interchangeable, both directions were confirmed to break it.
    IF NOT tbl_done THEN
      EXECUTE 'ALTER TABLE "ncmec_safety_audit_log" OWNER TO overhype_audit_owner';
    END IF;
    IF NOT fn_done THEN
      EXECUTE 'ALTER FUNCTION ncmec_safety_audit_log_append_only() OWNER TO overhype_audit_owner';
    END IF;
    IF to_regrole('overhype_audit_owner') <> to_regrole(current_user) THEN
      EXECUTE 'SET LOCAL ROLE overhype_audit_owner';
    END IF;
    -- The application role keeps exactly what it needs to append and read. Unconditional
    -- rather than gated on grants_done: GRANT is idempotent (re-granting an already-held
    -- privilege is a no-op), and grants_done is not a trustworthy signal at this specific
    -- point — see the comment on its computation above for why.
    EXECUTE format('GRANT SELECT, INSERT ON TABLE "ncmec_safety_audit_log" TO %I', app_role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE "ncmec_safety_audit_log_id_seq" TO %I', app_role);
    -- Restores the role this block was ENTERED under, which is not what RESET ROLE does: it
    -- returns to `session_user`, verified directly against this repository's PostgreSQL 16
    -- target. Same hazard, same fix as pg_temp.ncmec_assume_path's — a DBA replaying the
    -- migration with `SET ROLE <app>; \i 0095.sql` would otherwise have every statement after
    -- this line run as their own login role instead of the application role.
    EXECUTE format('SET LOCAL ROLE %I', app_role);
    -- can_set_own is this branch's entry condition, and it implies can_own (a role that can SET
    -- ROLE to overhype_audit_owner trivially satisfies the effective-access check), so the
    -- transfer just performed is NEVER the final state on its own: the application can still
    -- become overhype_audit_owner until a DBA runs the revocation. Round 10 finding: this used
    -- to unconditionally claim "now complete" the moment tbl_done/fn_done/grants_done were
    -- all true, which was never actually true in this branch specifically.
    boundary_note :=
      ' The application can still become overhype_audit_owner itself — to finish, a DBA must run, as a role with ADMIN OPTION on it: ' || revoke_hint;
    IF can_own_schema THEN
      boundary_note := boundary_note
        || ' The containing schema (' || quote_ident(ledger_schema) || ') is owned by ' || quote_ident(schema_owner_role)
        || ', a role the application can also become — see this block''s other branches for what closing that requires.';
    END IF;
    IF can_own_function_schema AND function_schema IS DISTINCT FROM ledger_schema THEN
      boundary_note := boundary_note
        || ' The guard function''s own containing schema (' || quote_ident(function_schema) || ') is owned by ' || quote_ident(function_schema_owner_role)
        || ', a role the application can also become.';
    END IF;
    boundary_note := boundary_note || maintenance_note;
    RAISE WARNING '0095: ncmec_safety_audit_log ownership hardening reconciled (table was already done: %, function was already done: %, grants were already done: %), but the boundary is not yet complete.%',
      tbl_done, fn_done, grants_done, boundary_note;
  ELSIF tbl_done AND fn_done AND NOT grants_done THEN
    -- Hardened but incomplete, and the sharpest of the end states this block can leave a
    -- database in: ownership of both objects has already moved to overhype_audit_owner, but
    -- the application was never granted SELECT/INSERT on the table or USAGE/SELECT on the
    -- sequence, so every single audit-log write fails. Unlike the ownership-incomplete case
    -- below (which the runtime boundary status already surfaces and the activation gate
    -- already blocks on), nothing else in this system detects a missing grant — it is a
    -- functional break, not a security one, so it would only surface as a production failure
    -- the first time anything tries to write to the ledger. This migration cannot fix it
    -- itself (that is precisely the access it no longer has), so it refuses to be recorded as
    -- successful rather than let the deploy proceed silently broken.
    --
    -- What this branch may NOT do is claim the security boundary is closed. It used to say
    -- "the application role cannot assume it", which was true only while the branch above it
    -- was `ELSIF can_own`: every reachable-owner case was caught there first. That branch is
    -- now `ELSIF can_set_own` (an INHERIT-only or admin-option grant cannot execute the
    -- transfer), so a database where the application still REACHES overhype_audit_owner but
    -- cannot SET ROLE to it now lands here — and following only the two GRANTs below would
    -- leave that bypass wide open while this message asserted it was closed.
    -- Same for the maintenance role, which was never considered here at all.
    --
    -- The printed recovery commands are schema-qualified (via ledger_schema, resolved above)
    -- and identifier-quoted (via format()'s %I), not bare names — a DBA who ran these literally
    -- under a search_path that doesn't put the ledger's actual schema first would hit
    -- "relation does not exist", and app_role could in principle need quoting too.
    boundary_note := '';
    IF can_own THEN
      boundary_note := boundary_note
        || ' The application can ALSO still effectively assume overhype_audit_owner, so the boundary is not closed even once the grants above are in place. To close it, as a role with ADMIN OPTION on it: '
        || revoke_hint;
    END IF;
    boundary_note := boundary_note || maintenance_note;
    RAISE EXCEPTION '%', format(
      '0095: ncmec_safety_audit_log and its guard function are both owned by overhype_audit_owner, but the application was never granted SELECT/INSERT on ncmec_safety_audit_log or USAGE/SELECT on ncmec_safety_audit_log_id_seq. Every audit-log write will fail until a DBA runs, as overhype_audit_owner or a role that can SET ROLE to it: '
      'GRANT SELECT, INSERT ON %I.%I TO %I; '
      'GRANT USAGE, SELECT ON SEQUENCE %I.%I TO %I;%s',
      ledger_schema, 'ncmec_safety_audit_log', app_role,
      ledger_schema, 'ncmec_safety_audit_log_id_seq', app_role,
      boundary_note
    );
  ELSE
    -- The last clause of the instruction is the one that actually matters, and it is why
    -- the transfer cannot be completed from inside this migration: transferring ownership
    -- needs membership of the target role, and that membership is precisely what would let
    -- the application role SET ROLE back and disable the trigger. Someone with higher
    -- privilege has to do it and then step away.
    -- GRANT CREATE ON SCHEMA is not optional either, and is easy to miss: verified directly
    -- against this repository's PostgreSQL 16 target that `ALTER TABLE ... OWNER TO` fails
    -- with "permission denied for schema ..." without it, because Postgres requires the NEW
    -- owner (not the executing role) to hold CREATE on the object's schema — and PostgreSQL
    -- 15+ no longer grants that to every role by default the way pre-15 did. Discovered by
    -- direct experiment while adding test coverage for this block, not by reading the
    -- manual: the block's own transfer attempt below raised exactly this error against a
    -- freshly `CREATE ROLE`'d owner with no other grants.
    --
    -- The schema named is `ledger_schema` (resolved above), never hardcoded "public": under
    -- any search_path that doesn't put public first — including this repo's own
    -- isolated-test-schema tooling, or a real deployment with a non-default search_path — a
    -- DBA who followed a hardcoded "public" instruction to the letter would still hit
    -- "permission denied for schema <real schema>" on the OWNER TO below.
    --
    -- Every object reference below is schema-qualified (via ledger_schema) and
    -- identifier-quoted (via format()'s %I), not just the GRANT CREATE ON SCHEMA line — a
    -- DBA running these commands under a search_path that doesn't put ledger_schema first
    -- would otherwise hit "relation does not exist" on the unqualified ALTER TABLE/FUNCTION
    -- and GRANT statements too, exactly the same class of failure the GRANT CREATE ON SCHEMA
    -- qualification above already exists to avoid.
    --
    -- Assembled statement by statement rather than from one of N fixed templates. Three
    -- independent conditions each add or change a line — whether overhype_audit_owner already
    -- exists, whether the guard function lives in its own schema, and which grant actually has
    -- to be revoked — and a template per combination is both unreadable and exactly the shape
    -- that lets a positional format() argument silently drift out of alignment with its
    -- directive. Every object reference is still schema-qualified and identifier-quoted via
    -- format()'s %I, per the comment above.
    --
    -- The CREATE ROLE line is included only when overhype_audit_owner does not exist yet.
    -- Reaching this branch does NOT mean the role is missing: it means the migration could not
    -- perform the transfer itself, which is equally true when the role exists but the
    -- application cannot SET ROLE to it — either because it genuinely cannot become it at all
    -- (the correctly-hardened end state) or because it holds only INHERIT-only/admin-option
    -- access, which the effective-access check counts as a bypass but which cannot execute
    -- ALTER ... OWNER TO. Printing CREATE ROLE unconditionally would make a DBA's literal
    -- copy-paste fail on "role already exists" before any of the transfer or grants ran, in
    -- exactly those states. PostgreSQL has no CREATE ROLE IF NOT EXISTS form (unlike CREATE
    -- TABLE, verified directly against this repository's PostgreSQL 16 target), so this is
    -- constructed conditionally rather than made idempotent syntactically.
    recovery_cmds :=
      '0095: ncmec_safety_audit_log is owned by the application role, so ALTER TABLE ... DISABLE TRIGGER can still bypass the append-only guarantee. To complete the boundary a DBA must run, as a role the application is not a member of: ';
    IF NOT owner_role_exists THEN
      -- The self-grant is not redundant with the CREATE, and omitting it made this whole
      -- sequence fail for exactly the audience it is written for. Verified directly against
      -- this repository's PostgreSQL 16 target: when a non-superuser CREATEROLE role creates
      -- another, the automatic membership it receives is `admin_option = t, inherit_option = f,
      -- set_option = f` — ADMIN OPTION but NOT SET. `ALTER TABLE ... OWNER TO` requires the
      -- executor to be able to SET ROLE to the new owner, so the very next line failed with
      -- "must be able to SET ROLE" for any DBA who was not a superuser. Confirmed in both
      -- directions: the transfer fails before this GRANT and succeeds after it. The ADMIN
      -- OPTION the creator already holds is what makes the role able to issue this grant to
      -- itself. The REVOKE at the end of the sequence removes it again, so the SET access
      -- exists only for the span of the transfer.
      recovery_cmds := recovery_cmds
        || 'CREATE ROLE overhype_audit_owner NOLOGIN; '
        || 'GRANT overhype_audit_owner TO CURRENT_USER WITH SET TRUE; ';
    END IF;
    recovery_cmds := recovery_cmds || format('GRANT CREATE ON SCHEMA %I TO overhype_audit_owner; ', ledger_schema);
    -- A SECOND GRANT CREATE, on the guard function's own schema, whenever it differs from the
    -- table's. PostgreSQL requires the new owner to hold CREATE on the schema containing the
    -- object being reassigned — the table's schema is not that schema for the ALTER FUNCTION
    -- line below, so without this a DBA following these instructions in order still fails on
    -- "permission denied for schema <function_schema>" at the function transfer, having
    -- already completed the table's. Emitted conditionally because in the ordinary case the
    -- two schemas are identical and a duplicate GRANT would just be noise.
    IF function_schema IS DISTINCT FROM ledger_schema THEN
      recovery_cmds := recovery_cmds || format('GRANT CREATE ON SCHEMA %I TO overhype_audit_owner; ', function_schema);
    END IF;
    recovery_cmds := recovery_cmds
      || format('ALTER TABLE %I.%I OWNER TO overhype_audit_owner; ', ledger_schema, 'ncmec_safety_audit_log')
      -- ALTER FUNCTION targets function_schema, not ledger_schema — round 10 finding: the
      -- guard function's own containing schema is resolved and checked independently of the
      -- table's, and this printed command must target the schema the function ACTUALLY lives
      -- in, not assume it matches the table's.
      || format('ALTER FUNCTION %I.ncmec_safety_audit_log_append_only() OWNER TO overhype_audit_owner; ', function_schema)
      || format('GRANT SELECT, INSERT ON %I.%I TO %I; ', ledger_schema, 'ncmec_safety_audit_log', app_role)
      || format('GRANT USAGE, SELECT ON SEQUENCE %I.%I TO %I; ', ledger_schema, 'ncmec_safety_audit_log_id_seq', app_role)
      || format('REVOKE overhype_audit_maintenance FROM %I; ', app_role);
    -- The owner-role revocation names the grant that actually breaks the path (see revoke_hint
    -- above), which is only `REVOKE overhype_audit_owner FROM <app>` when the application holds
    -- it directly. When it does not — an admin-option chain — that command removes a membership
    -- that was never there: the DBA sees it succeed, the bypass stays open, and the next rerun
    -- of 0095 prints this same instruction again, indefinitely. `revoke_hint` is NULL only when
    -- can_own is false, i.e. there is no path left to break, in which case nothing is appended.
    IF revoke_hint IS NOT NULL THEN
      recovery_cmds := recovery_cmds || revoke_hint;
    ELSIF NOT owner_role_exists THEN
      -- The role does not exist yet, so the application holds no path to it and revoke_hint is
      -- NULL — but the DBA is being told to CREATE it two lines up, and on PostgreSQL 16 a
      -- CREATEROLE role that creates another is automatically granted it. The membership that
      -- has to go therefore belongs to whoever runs these commands, a name this migration
      -- cannot know, so the instruction names the creator rather than app_role. The old
      -- unconditional `REVOKE overhype_audit_owner FROM <app>` pointed at the wrong role here:
      -- it succeeds, changes nothing, and leaves the creator's membership in place.
      recovery_cmds := recovery_cmds
        || 'REVOKE overhype_audit_owner FROM <the role that runs the CREATE ROLE above>;';
    END IF;

    -- The REVOKEs above are not optional: on PostgreSQL 16 creating a role auto-grants it to
    -- the creator, and any membership left in place keeps the trigger bypassable and
    -- ncmecAuditBoundaryStatus().boundaryEnforced false. quote_ident(), not another format()
    -- call, builds the schema-ownership note: nesting format() calls would let a literal '%'
    -- inside a resolved role/schema name corrupt the OUTER format() call's own directive
    -- parsing, however unlikely that is to occur in practice.
    boundary_note := ' -- the REVOKEs are not optional: on PostgreSQL 16 creating a role auto-grants it to the creator, and any membership left in place keeps the trigger bypassable and ncmecAuditBoundaryStatus().boundaryEnforced false.';
    IF can_own_schema THEN
      boundary_note := boundary_note
        || ' Once that is done, the containing schema (' || quote_ident(ledger_schema)
        || ') is STILL owned by ' || quote_ident(schema_owner_role)
        || ', a role the application can also become — closing the table/function bypass alone leaves a DROP TABLE/DROP FUNCTION bypass open via the schema; see this migration''s ownership-hardening comments for what closing it requires.';
    END IF;
    IF can_own_function_schema AND function_schema IS DISTINCT FROM ledger_schema THEN
      boundary_note := boundary_note
        || ' The guard function''s own containing schema (' || quote_ident(function_schema)
        || ') is STILL owned by ' || quote_ident(function_schema_owner_role)
        || ', a role the application can also become — the same reconciliation gap applies to it independently of the table''s schema.';
    END IF;
    RAISE WARNING '%', recovery_cmds || boundary_note || maintenance_note;
  END IF;
END $$;
-- <<< ncmec-0095 ownership hardening block (end)
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
