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
  con_ok  boolean;
  dup_name text;
BEGIN
  -- The FULL definition is verified, not just which table it points at. `confrelid` alone
  -- accepts a same-named constraint on the right target table that nonetheless has the wrong
  -- local column, the wrong referenced column, or the wrong referential actions — and this
  -- migration would then record success over a database where `quarantine_id` is not actually
  -- constrained, or where deletes behave differently than the design assumes.
  --   conkey      — the local column(s)
  --   confkey     — the referenced column(s)
  --   confdeltype — ON DELETE action ('n')
  --   confupdtype — ON UPDATE action ('a' = NO ACTION)
  SELECT c.oid,
         c.confrelid = to_regclass('quarantined_memes')
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                WHERE attrelid = to_regclass('ncmec_reports') AND attname = 'quarantine_id')]::smallint[]
         AND c.confkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                 WHERE attrelid = to_regclass('quarantined_memes') AND attname = 'id')]::smallint[]
         AND c.confdeltype = 'n'
         AND c.confupdtype = 'a'
         AND c.convalidated
    INTO con_oid, con_ok
    FROM pg_catalog.pg_constraint c
   WHERE c.conname = 'ncmec_reports_quarantine_id_fk'
     AND c.conrelid = to_regclass('ncmec_reports')
     AND c.contype = 'f';

  -- Ownership-aware, for the same reason the action-check and trigger paths are: after a DBA
  -- has transferred the ledger, the application role cannot ALTER it, and an unconditional
  -- DROP/ADD aborts the migration with "must be owner of table". That is precisely the
  -- database that still needs reconciling — a hardened ledger carrying the old
  -- ON DELETE SET NULL foreign key can never converge if the repair cannot run there.
  BEGIN
    IF con_oid IS NOT NULL AND NOT COALESCE(con_ok, false) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ncmec_reports', 'ncmec_reports_quarantine_id_fk');
      con_oid := NULL;
    END IF;

    IF con_oid IS NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE set null ON UPDATE no action',
        'ncmec_reports', 'ncmec_reports_quarantine_id_fk', 'quarantine_id', 'quarantined_memes', 'id');
    END IF;

    FOR dup_name IN
      SELECT c.conname FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = to_regclass('ncmec_reports')
         AND c.contype = 'f'
         AND c.conname <> 'ncmec_reports_quarantine_id_fk'
         AND c.confrelid = to_regclass('quarantined_memes')
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                WHERE attrelid = to_regclass('ncmec_reports') AND attname = 'quarantine_id')]::smallint[]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ncmec_reports', dup_name);
      RAISE NOTICE '0097: dropped duplicate foreign key % on ncmec_reports.quarantine_id (kept ncmec_reports_quarantine_id_fk)', dup_name;
    END LOOP;
  EXCEPTION WHEN insufficient_privilege THEN
    -- A warning, not an exception, and the asymmetry with the action check is deliberate: a
    -- missing action CHECK lets a bad value INTO an append-only ledger, which can never be
    -- corrected afterwards, so that case refuses to proceed. A stale referential action is a
    -- latent hazard on a delete path nothing currently exercises, and failing the whole
    -- migration over it would block every other reconciliation this file performs.
    RAISE WARNING '0097: the foreign key ncmec_reports_quarantine_id_fk on ncmec_reports.quarantine_id needs reconciling but this role does not own the table. A DBA must run, as its owner: ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I; ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I(%I) ON DELETE set null ON UPDATE no action; -- and drop any other foreign key on the same column.',
      (SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('ncmec_reports')), 'ncmec_reports', 'ncmec_reports_quarantine_id_fk',
      (SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('ncmec_reports')), 'ncmec_reports', 'ncmec_reports_quarantine_id_fk',
      'quarantine_id',
      -- The REFERENCED table is schema-qualified too. Qualifying only the source table
      -- left `REFERENCES quarantined_memes(id)` to resolve through whatever search_path the DBA
      -- happens to have — so on a deployment using a non-default schema the command either
      -- fails outright or, worse, binds the repaired foreign key to a same-named table in
      -- another schema. Either way the replay never converges, which is the whole point of
      -- emitting the command.
      (SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('quarantined_memes')), 'quarantined_memes', 'id';
  END;

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
-- migrations.0097.test.ts asserts the two agree, so the lockstep is enforced
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
-- migrations.0097.test.ts slices on the two sentinels below so it can replay
-- the classification against fixtures without re-running the whole migration.
-- Keep them wrapping exactly the DO block, and keep each sentinel alone on its
-- line — the test executes everything between them verbatim.
-- >>> ncmec-0097 backfill block (start)
DO $$
DECLARE
  n_missing     bigint;
  n_malformed   bigint;
  n_dangling    bigint;
  n_conflicting bigint;
  -- Rows the CLASSIFICATION judged linkable. Deliberately not called `n_linked`: it is a
  -- pre-update count, and the UPDATE's target-side `quarantine_id IS NULL` recheck can
  -- legitimately skip some of them when a concurrent reconciler or operator wins the race.
  -- Reporting this number as "linked" made the diagnostics wrong in exactly the situation the
  -- recheck was added to handle — a run that quietly deferred to another writer looked
  -- identical to one that did all the linking itself.
  n_candidates  bigint;
  -- What the UPDATE actually wrote, from ROW_COUNT.
  n_linked      bigint;
  conflict_ids  text;
BEGIN
  -- Classified with CTEs rather than a TEMP table, and that is a privilege decision rather
  -- than a style one: CREATE TEMP TABLE needs TEMPORARY on the database, which a locked-down
  -- application role replaying this migration may not hold. Such a role aborted here, in the
  -- very first block, long before reaching any of the hardened-replay handling further down —
  -- so the no-TEMP replay path the rest of this file supports was unreachable in practice.
  -- The classification itself is unchanged: the same four shapes, the same MATERIALIZED
  -- barrier keeping the bigint cast away from unvalidated text, and dangling still resolved
  -- before conflicting so a dangling row cannot make its twin look like a conflict.
  WITH raw AS MATERIALIZED (
    SELECT r.id AS report_id, r.request_metadata->>'quarantineId' AS raw_qid
      FROM ncmec_reports r
     WHERE r.quarantine_id IS NULL
  ),
  typed AS MATERIALIZED (
    SELECT report_id,
           raw_qid,
           -- Bounded to 18 digits, NOT just `^[0-9]+$`. A digit-only value can still overflow:
           -- `'999999999999999999999999'::bigint` raises numeric_value_out_of_range, which
           -- aborts the whole migration — the exact failure this classification exists to
           -- prevent, surviving in the subclass a shape-only regex lets through.
           CASE WHEN raw_qid IS NULL THEN 'missing'
                WHEN raw_qid !~ '^[0-9]{1,18}$' THEN 'malformed'
                ELSE 'numeric' END AS shape
      FROM raw
  ),
  cast_ok AS MATERIALIZED (
    SELECT report_id, raw_qid, shape,
           CASE WHEN shape <> 'numeric' THEN NULL ELSE raw_qid::bigint END AS qid
      FROM typed
  ),
  with_dangling AS MATERIALIZED (
    SELECT c.report_id, c.qid,
           CASE WHEN c.shape = 'numeric'
                 AND NOT EXISTS (SELECT 1 FROM quarantined_memes q WHERE q.id = c.qid)
                THEN 'dangling' ELSE c.shape END AS shape
      FROM cast_ok c
  ),
  classified AS MATERIALIZED (
    -- Conflicting: two or more reports claiming the SAME quarantine row. Never auto-picked —
    -- choosing one would silently discard a real report's linkage, and the choice is exactly
    -- the judgement a human has to make.
    SELECT w.report_id, w.qid,
           CASE WHEN w.shape = 'numeric'
                 AND (EXISTS (SELECT 1 FROM with_dangling o
                               WHERE o.qid = w.qid AND o.report_id <> w.report_id
                                 AND o.shape = 'numeric')
                      OR EXISTS (SELECT 1 FROM ncmec_reports r
                                  WHERE r.quarantine_id = w.qid AND r.id <> w.report_id))
                THEN 'conflicting' ELSE w.shape END AS shape
      FROM with_dangling w
  )
  SELECT count(*) FILTER (WHERE shape = 'missing'),
         count(*) FILTER (WHERE shape = 'malformed'),
         count(*) FILTER (WHERE shape = 'dangling'),
         count(*) FILTER (WHERE shape = 'conflicting'),
         count(*) FILTER (WHERE shape = 'numeric'),
         string_agg(DISTINCT qid::text, ', ') FILTER (WHERE shape = 'conflicting')
    INTO n_missing, n_malformed, n_dangling, n_conflicting, n_candidates, conflict_ids
    FROM classified;

  IF n_conflicting > 0 THEN
    RAISE EXCEPTION
      '0097: % ncmec_reports rows claim a quarantine row another report already claims (quarantined_memes ids: %). Resolve by hand before migrating — pick the authoritative report per quarantine row and clear the other''s request_metadata->>''quarantineId''. Auto-picking would silently discard a real report''s linkage.',
      n_conflicting, conflict_ids;
  END IF;

  -- Reached only when nothing conflicts, so the EXISTS below is the only remaining exclusion
  -- (it is what leaves dangling ids NULL). The regex is repeated rather than carried over,
  -- because a CTE cannot span statements.
  WITH linkable AS MATERIALIZED (
    SELECT r.id AS report_id, (r.request_metadata->>'quarantineId')::bigint AS qid
      FROM ncmec_reports r
     WHERE r.quarantine_id IS NULL
       AND r.request_metadata->>'quarantineId' ~ '^[0-9]{1,18}$'
  )
  UPDATE ncmec_reports r
     SET quarantine_id = l.qid
    FROM linkable l
   WHERE r.id = l.report_id
     -- Rechecked on the TARGET row, not only inside `linkable`. The CTE's own filter runs at
     -- snapshot time; this one is re-evaluated by PostgreSQL's update revalidation after any
     -- concurrent writer commits, which is what actually fences the backfill. Without it a
     -- replay running alongside the reconciler (or an operator) could read a NULL, wait on
     -- another transaction that writes the authoritative linkage, and then overwrite that
     -- value with the legacy JSON one — contradicting the explicit-value-wins rule the
     -- adjacent trigger states in so many words. Lost in the CTE rewrite, which moved this
     -- predicate into the source side where it no longer fences anything.
     AND r.quarantine_id IS NULL
     AND EXISTS (SELECT 1 FROM quarantined_memes q WHERE q.id = l.qid);

  -- The rows the statement WROTE, not the rows it considered. The two differ by exactly the
  -- candidates the target-side recheck deferred on, which is a real outcome an operator needs
  -- named rather than absorbed into the linked count.
  GET DIAGNOSTICS n_linked = ROW_COUNT;

  -- Observability, per the migration-review rule: a backfill that reports nothing cannot be
  -- told from one that matched nothing. Dropped by the CTE rewrite, which computed all four
  -- counts and then discarded them — leaving an operator unable to distinguish a clean no-op
  -- from a migration that deliberately left rows for the backlog audit to disposition.
  RAISE NOTICE '0097 quarantine_id backfill: linked=%, missing=% (pre-stub rows — stay NULL, they are the backlog audit''s population), malformed=%, dangling=%',
    n_linked, n_missing, n_malformed, n_dangling;

  IF n_candidates > n_linked THEN
    -- Not a failure and not a warning: the recheck doing its job. Reported because "linked=0,
    -- everything else 0" would otherwise be indistinguishable from a database with nothing to
    -- backfill, and the difference matters when someone is auditing whether a replay raced a
    -- live reconciler.
    RAISE NOTICE '0097 quarantine_id backfill: % of % linkable candidates were already linked by another writer between classification and update, and were left alone.',
      n_candidates - n_linked, n_candidates;
  END IF;

  IF n_malformed > 0 OR n_dangling > 0 THEN
    RAISE WARNING '0097: % malformed and % dangling quarantineId values left NULL. These rows are unlinked and must be dispositioned by the pre-activation backlog audit.',
      n_malformed, n_dangling;
  END IF;
END $$;
-- <<< ncmec-0097 backfill block (end)
--> statement-breakpoint

-- ─── 4b. The backfill is one-shot; the deploy window is not ─────────────────
--
-- 0097 commits before the new code is serving everywhere. During a rolling deploy an OLD
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
      RAISE EXCEPTION '0097: an index named "UQ_ncmec_reports_quarantine" already exists but is not the exact unique constraint this migration requires (unique on ncmec_reports(quarantine_id) WHERE quarantine_id IS NOT NULL). This is the constraint that keeps two concurrent orphan sweeps from filing two reports for one quarantine hit; refusing to silently accept a wrong or drifted index. Inspect it with: SELECT indexdef FROM pg_indexes WHERE indexname = ''UQ_ncmec_reports_quarantine''; — then drop it and rerun this migration.';
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
-- migrations.0097.test.ts asserts the two agree, so the lockstep is enforced rather than
-- remembered.
-- Inspect-then-reconcile rather than an unconditional DROP + ADD, and that is load-bearing for
-- exactly the recovery state the ownership-hardening block below is built to support. Once a
-- DBA has transferred this ledger to `overhype_audit_owner`, the application role no longer
-- owns it — and `ALTER TABLE ... DROP CONSTRAINT` requires ownership, so an unconditional pair
-- of ALTERs here aborts the whole migration before that block ever runs. The hash-based
-- migrator reaches this path whenever migration tracking is lost or 0097's hash changes, which
-- is the same rerun scenario the ownership block's verify-and-continue logic already exists to
-- survive. So: an existing, correct constraint is accepted untouched, and a missing or drifted
-- one is repaired only if this role can actually alter the table — otherwise the exact
-- owner-run commands are reported instead of failing on "must be owner of table".
-- >>> ncmec-0097 action check block (start)
DO $$
DECLARE
  ledger_schema text;
BEGIN
  SELECT n.nspname INTO ledger_schema
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = to_regclass('ncmec_safety_audit_log');

  -- Unconditional DROP + ADD, deliberately. Earlier revisions inspected an existing
  -- constraint and skipped the rebuild when it looked correct, which required deciding
  -- whether a predicate pulled out of pg_get_constraintdef enforces the intended closed
  -- vocabulary. That question cannot be answered soundly from the rendered text — five
  -- successive attempts (a literal string, the mentioned literal set, an anchored shape, an
  -- anchored shape plus literal set, and that widened for PostgreSQL's two renderings) were
  -- each defeated by a predicate matching the check while admitting values outside the
  -- vocabulary, most recently
  -- `ARRAY[<the nine literals>, CASE WHEN length(action) = 13 THEN action ELSE 'retry' END]`.
  --
  -- Rebuilding unconditionally makes the question unnecessary: whatever was there is
  -- replaced by the constraint this migration writes, so the post-condition holds by
  -- construction rather than by inspection. The rebuild is safe because the ledger is
  -- append-only over this same vocabulary — every row already in it satisfied this
  -- constraint when written — and cheap because the table is small by design.
  BEGIN
    EXECUTE 'ALTER TABLE "ncmec_safety_audit_log" DROP CONSTRAINT IF EXISTS "ncmec_safety_audit_log_action_check"';
    EXECUTE $stmt$ALTER TABLE "ncmec_safety_audit_log" ADD CONSTRAINT "ncmec_safety_audit_log_action_check"
  CHECK ("action" IN ('retry','send_to_test_started','send_to_test_completed','backlog_audit','approve_identity_omission','mark_manually_filed','correct_manual_filing','reopen','config_write'))$stmt$;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Reached only on a ledger a DBA has already hardened, where this role no longer owns the
    -- table. Reported rather than fatal: the hardening runbook is what put ownership out of
    -- reach, and the same runbook carries this command, so aborting here would block every
    -- other reconciliation this file performs on precisely the databases that followed the
    -- documented procedure.
    -- `RAISE EXCEPTION '%', format(...)`, never RAISE's own directives: RAISE understands only
    -- bare `%` and would emit the literal letter for `%I`/`%L`/`%s`.
    RAISE WARNING '%', format(
      '0097: could not rebuild ncmec_safety_audit_log_action_check — this role does not own %I.%I. Run, as the table''s owner: ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS "ncmec_safety_audit_log_action_check"; ALTER TABLE %I.%I ADD CONSTRAINT "ncmec_safety_audit_log_action_check" CHECK ("action" IN (%s));',
      ledger_schema, 'ncmec_safety_audit_log',
      ledger_schema, 'ncmec_safety_audit_log',
      ledger_schema, 'ncmec_safety_audit_log',
      (SELECT string_agg(quote_literal(v), ',' ORDER BY v)
         FROM unnest(ARRAY['retry','send_to_test_started','send_to_test_completed','backlog_audit',
                           'approve_identity_omission','mark_manually_filed','correct_manual_filing',
                           'reopen','config_write']) AS v)
    );
  END;
END $$;
-- <<< ncmec-0097 action check block (end)
--> statement-breakpoint

-- ON DELETE **RESTRICT**, not SET NULL, and the reason is the append-only guarantee rather
-- than referential taste. `SET NULL` is implemented as an UPDATE of the referencing table, so
-- deleting an `ncmec_reports` row that has any audit entry makes PostgreSQL issue an UPDATE
-- against this ledger — which the always-enabled append-only trigger then either REJECTS (the
-- delete fails for the application role, from a constraint nobody looking at the delete would
-- suspect) or, run under the maintenance role, ALLOWS: silently rewriting historical entries
-- of a legal record. A ledger a foreign key can mutate is not append-only.
--
-- RESTRICT resolves both by refusing the delete outright, which is also the correct behavior on
-- its own terms: a report whose handling was logged here has legal-consequence history, and
-- deleting it would strand entries describing actions taken on a report that no longer exists.
-- Nothing in the application deletes ncmec_reports today, so this constrains no live path; it
-- constrains the cleanup path someone will eventually write.
--
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
  con_ok  boolean;
  dup_name text;
BEGIN
  -- The FULL definition is verified, not just which table it points at. `confrelid` alone
  -- accepts a same-named constraint on the right target table that nonetheless has the wrong
  -- local column, the wrong referenced column, or the wrong referential actions — and this
  -- migration would then record success over a database where `report_id` is not actually
  -- constrained, or where deletes behave differently than the design assumes.
  -- Reconciling confdeltype is what MIGRATES an existing ledger off the old ON DELETE SET
  -- NULL action, which was incompatible with the append-only trigger (see below).
  --   conkey      — the local column(s)
  --   confkey     — the referenced column(s)
  --   confdeltype — ON DELETE action ('r')
  --   confupdtype — ON UPDATE action ('a' = NO ACTION)
  SELECT c.oid,
         c.confrelid = to_regclass('ncmec_reports')
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                WHERE attrelid = to_regclass('ncmec_safety_audit_log') AND attname = 'report_id')]::smallint[]
         AND c.confkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                 WHERE attrelid = to_regclass('ncmec_reports') AND attname = 'id')]::smallint[]
         AND c.confdeltype = 'r'
         AND c.confupdtype = 'a'
         AND c.convalidated
    INTO con_oid, con_ok
    FROM pg_catalog.pg_constraint c
   WHERE c.conname = 'ncmec_safety_audit_log_report_id_fk'
     AND c.conrelid = to_regclass('ncmec_safety_audit_log')
     AND c.contype = 'f';

  -- Ownership-aware, for the same reason the action-check and trigger paths are: after a DBA
  -- has transferred the ledger, the application role cannot ALTER it, and an unconditional
  -- DROP/ADD aborts the migration with "must be owner of table". That is precisely the
  -- database that still needs reconciling — a hardened ledger carrying the old
  -- ON DELETE SET NULL foreign key can never converge if the repair cannot run there.
  BEGIN
    IF con_oid IS NOT NULL AND NOT COALESCE(con_ok, false) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ncmec_safety_audit_log', 'ncmec_safety_audit_log_report_id_fk');
      con_oid := NULL;
    END IF;

    IF con_oid IS NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE restrict ON UPDATE no action',
        'ncmec_safety_audit_log', 'ncmec_safety_audit_log_report_id_fk', 'report_id', 'ncmec_reports', 'id');
    END IF;

    FOR dup_name IN
      SELECT c.conname FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = to_regclass('ncmec_safety_audit_log')
         AND c.contype = 'f'
         AND c.conname <> 'ncmec_safety_audit_log_report_id_fk'
         AND c.confrelid = to_regclass('ncmec_reports')
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                WHERE attrelid = to_regclass('ncmec_safety_audit_log') AND attname = 'report_id')]::smallint[]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ncmec_safety_audit_log', dup_name);
      RAISE NOTICE '0097: dropped duplicate foreign key % on ncmec_safety_audit_log.report_id (kept ncmec_safety_audit_log_report_id_fk)', dup_name;
    END LOOP;
  EXCEPTION WHEN insufficient_privilege THEN
    -- A warning, not an exception, and the asymmetry with the action check is deliberate: a
    -- missing action CHECK lets a bad value INTO an append-only ledger, which can never be
    -- corrected afterwards, so that case refuses to proceed. A stale referential action is a
    -- latent hazard on a delete path nothing currently exercises, and failing the whole
    -- migration over it would block every other reconciliation this file performs.
    RAISE WARNING '0097: the foreign key ncmec_safety_audit_log_report_id_fk on ncmec_safety_audit_log.report_id needs reconciling but this role does not own the table. A DBA must run, as its owner: ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I; ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I(%I) ON DELETE restrict ON UPDATE no action; -- and drop any other foreign key on the same column.',
      (SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('ncmec_safety_audit_log')), 'ncmec_safety_audit_log', 'ncmec_safety_audit_log_report_id_fk',
      (SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('ncmec_safety_audit_log')), 'ncmec_safety_audit_log', 'ncmec_safety_audit_log_report_id_fk',
      'report_id',
      -- The REFERENCED table is schema-qualified too. Qualifying only the source table
      -- left `REFERENCES ncmec_reports(id)` to resolve through whatever search_path the DBA
      -- happens to have — so on a deployment using a non-default schema the command either
      -- fails outright or, worse, binds the repaired foreign key to a same-named table in
      -- another schema. Either way the replay never converges, which is the whole point of
      -- emitting the command.
      (SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('ncmec_reports')), 'ncmec_reports', 'id';
  END;

END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "IDX_ncmec_audit_report_created"
  ON "ncmec_safety_audit_log" ("report_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_ncmec_audit_created"
  ON "ncmec_safety_audit_log" ("created_at" DESC);
--> statement-breakpoint

-- The maintenance role, `overhype_audit_maintenance`, is NOT created here.
--
-- It used to be, best-effort, and that was the single largest source of defects in this
-- file. On PostgreSQL 16 a non-superuser CREATEROLE role that runs `CREATE ROLE x` is
-- automatically granted x WITH ADMIN OPTION, with the BOOTSTRAP SUPERUSER as grantor — so
-- the application ended up holding a membership it could re-grant to itself at will, and
-- could not revoke, because a REVOKE by anyone other than the grantor warns and changes
-- nothing rather than failing. The migration was creating the bypass it existed to prevent,
-- and then reporting that it had closed it.
--
-- Creating the role belongs to the hardening runbook, run by a superuser, which is the only
-- actor that can create it without conferring that membership. See
-- docs/engineering/ncmec-audit-ledger-hardening.md.
--
-- Until then the trigger fails CLOSED: its guard checks `pg_catalog.pg_roles` first, so with
-- the role absent NO session can UPDATE, DELETE or TRUNCATE this ledger. That is strictly
-- stricter than the previous behaviour, not weaker.


-- The audit-log guard objects are created only when the current role is able to. After the
-- DBA hardening step below, `ncmec_safety_audit_log` and this function belong to
-- `overhype_audit_owner`, and an unguarded `CREATE OR REPLACE FUNCTION` would fail with
-- "must be owner of function" on any replay — which is exactly the recovery case where the
-- schema survived but migration tracking did not. When the objects are already in place and
-- this role may not touch them, the migration verifies them and moves on; when they are
-- MISSING and it cannot create them, it fails loudly rather than leaving the ledger
-- unguarded.
-- >>> ncmec-0097 audit guard block (start)
DO $outer$
DECLARE
  -- Captured on entry and restored explicitly at every probe below, instead of RESET ROLE.
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
  -- "Can this role act on the object?" is now exactly "does it own the object (or does the
  -- object not exist yet)". Earlier revisions ANSWERED IT BY ATTEMPTING `SET LOCAL ROLE` to
  -- the owner, and that probe has been removed along with every other role-switching path in
  -- this migration. The reason is the same one that removed the ownership transfer: the probe
  -- can only succeed where the application can already become the ledger's owner, which is
  -- precisely the state the hardening runbook exists to eliminate. On a correctly hardened
  -- database it always failed; on an incorrectly hardened one it silently exercised the
  -- bypass instead of reporting it. Owning the object is the honest question, it needs one
  -- catalog read, and it carries none of the restore hazard a nested SET ROLE does.
  can_fn  := fn_owner IS NULL OR fn_owner = to_regrole(current_user);
  can_tbl := tbl_owner IS NULL OR tbl_owner = to_regrole(current_user);

  IF can_fn THEN
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
  END IF;

  IF can_tbl THEN
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
      RAISE NOTICE '0097: ncmec_safety_audit_log is owned by another role, both append-only triggers are already present, enabled and correctly wired, and the guard function''s source still implements the check — leaving them alone.';
    ELSE
      RAISE EXCEPTION '0097: ncmec_safety_audit_log is owned by a role this session cannot assume, and either the append-only triggers are not both present/origin-enabled/correctly wired, or the guard function they call no longer appears to implement the check. A DBA must recreate them as the owner; refusing to leave the ledger unguarded.';
    END IF;
  END IF;
END $outer$;
-- <<< ncmec-0097 audit guard block (end)
--> statement-breakpoint

-- >>> ncmec-0097 ownership hardening block (start)
--
-- This migration does NOT attempt to harden the ledger's ownership, and that is the
-- deliberate scope of phase 1.
--
-- The append-only triggers stop row mutation, but `ALTER TABLE ... DISABLE TRIGGER` needs
-- only OWNERSHIP — and this migration runs as the application role, so it owns everything it
-- just created. A migration cannot manufacture a privilege boundary above itself: handing
-- ownership to `overhype_audit_owner` requires the ability to SET ROLE to that role, which is
-- exactly the access that would let the application take it back and disable the trigger.
--
-- Earlier revisions tried anyway — resolving role reachability through inherit, set and
-- admin-option chains, attempting the transfer when it looked possible, and printing repair
-- commands when it did not. Every one of those paths was either a no-op (the transfer only
-- succeeded where it bought nothing) or wrong in a way that reported success over an open
-- boundary. So the attempt is gone; what remains is the honest half.
--
-- The boundary is closed OUTSIDE this migration, by a superuser, following
-- docs/engineering/ncmec-audit-ledger-hardening.md. The residual state is queryable at
-- runtime — `ncmecAuditBoundaryStatus()` in lib/db — and phase 6's activation gate refuses
-- production filing while `boundaryEnforced` is false, which blocks the dangerous STATE
-- rather than any one path into it.
DO $$
DECLARE
  ledger_schema   text;
  function_schema text;
BEGIN
  SELECT n.nspname INTO ledger_schema
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = to_regclass('ncmec_safety_audit_log');
  SELECT n.nspname INTO function_schema
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'ncmec_safety_audit_log_append_only'
   LIMIT 1;

  RAISE WARNING '%', format(
    '0097: the append-only guarantee on %I.%I is NOT yet a privilege boundary. This migration ran as %I, which therefore owns the ledger (schema %I) and its guard function (schema %I) and can disable its own triggers. Closing the boundary requires a superuser and is documented in docs/engineering/ncmec-audit-ledger-hardening.md. Until it is run, ncmecAuditBoundaryStatus() reports boundaryEnforced = false and NCMEC production filing stays blocked.',
    ledger_schema, 'ncmec_safety_audit_log',
    current_user, ledger_schema, COALESCE(function_schema, ledger_schema)
  );
END $$;
-- <<< ncmec-0097 ownership hardening block (end)
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
