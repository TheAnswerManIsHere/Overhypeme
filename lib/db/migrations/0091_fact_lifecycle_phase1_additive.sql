-- Phase 2 fact-lifecycle closure — PART 1 of 2: ADDITIVE SCHEMA ONLY.
--
-- This migration is deliberately additive and safe to apply BEFORE the
-- writer-closure code (activateFact chokepoint, ingestion funnel, variant
-- reroute) ships, and it does NOT add the CHECK constraint or run the grandfather
-- backfill — those live in the Phase-2 data migration
-- (0092_fact_lifecycle_phase2_backfill_check.sql), which must run only after the
-- old active-writer code is gone and every active row has been made concept-valid.
-- Splitting the two prevents (a) a CHECK-before-backfill failure on grandfathered
-- rows and (b) a rolling-deploy race that lets old code insert a fresh violator
-- between the backfill scan and ADD CONSTRAINT. This server applies migrations at
-- startup, in order, before serving (see runMigrations() in the api-server entry),
-- so 0091 then 0092 run back-to-back under the writer-closed image.
--
-- Two changes:
--   1. Flip facts.is_active default true -> false. Facts are now born INACTIVE;
--      the only transition to active is the moderation activation chokepoint
--      (activateFact via approveForProduction). Affects FUTURE inserts only — no
--      existing row changes, and the old writers set is_active explicitly so they
--      are unaffected until rerouted.
--   2. Add pending_reviews.parent_fact_id (nullable integer FK -> facts.id,
--      ON DELETE SET NULL) — the carrier for VARIANT submissions from ingestion
--      through provisional-approve -> staging -> activation. Additive + nullable:
--      existing reviews simply have NULL (non-variant). Integer to match facts.id
--      (serial) and the other review->fact FKs.

-- 1. Default flip (idempotent — SET DEFAULT is declarative).
ALTER TABLE "facts" ALTER COLUMN "is_active" SET DEFAULT false;

-- 2. Variant parent carrier on pending_reviews.
ALTER TABLE "pending_reviews" ADD COLUMN IF NOT EXISTS "parent_fact_id" integer;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_reviews_parent_fact_id_facts_id_fk'
  ) THEN
    ALTER TABLE "pending_reviews"
      ADD CONSTRAINT "pending_reviews_parent_fact_id_facts_id_fk"
      FOREIGN KEY ("parent_fact_id") REFERENCES "facts"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Supports the ON DELETE SET NULL cascade and parent-scoped lookups.
CREATE INDEX IF NOT EXISTS "idx_pending_reviews_parent_fact" ON "pending_reviews" ("parent_fact_id");
