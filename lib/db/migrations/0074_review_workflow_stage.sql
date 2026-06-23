-- Two-gate, cost-gated moderation lifecycle.
--
-- Adds the fine-grained `workflow_stage` driver to pending_reviews plus the
-- inactive staging-fact pointer and production-rejection audit columns. The
-- coarse `status` (pending|approved|rejected) is unchanged; `workflow_stage`
-- distinguishes triage vs. prep vs. production review/decision.
--
-- Backfill here only maps EXISTING rows to a sensible terminal/triage stage by
-- their coarse status. Creating staging facts for enriched pending reviews is a
-- separate, idempotent TS backfill (lib/db/scripts/backfill-staging-facts.ts)
-- because it must materialize the effective enrichment blob — not expressible in
-- portable SQL. No enrichment/Pexels work is enqueued by this migration.

DO $$ BEGIN
  CREATE TYPE "public"."review_workflow_stage" AS ENUM(
    'triage_pending',
    'triage_rejected',
    'prep_pending',
    'prep_failed',
    'production_review',
    'production_rejected',
    'production_approved'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ADD COLUMN IF NOT EXISTS "workflow_stage" "public"."review_workflow_stage" NOT NULL DEFAULT 'triage_pending';
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ADD COLUMN IF NOT EXISTS "staging_fact_id" integer;
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ADD COLUMN IF NOT EXISTS "production_rejected_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ADD COLUMN IF NOT EXISTS "production_rejected_by_id" varchar;
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ADD COLUMN IF NOT EXISTS "production_rejection_note" text;
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  DROP CONSTRAINT IF EXISTS "pending_reviews_staging_fact_id_facts_id_fk";
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ADD CONSTRAINT "pending_reviews_staging_fact_id_facts_id_fk"
    FOREIGN KEY ("staging_fact_id") REFERENCES "public"."facts"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  DROP CONSTRAINT IF EXISTS "pending_reviews_production_rejected_by_id_users_id_fk";
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ADD CONSTRAINT "pending_reviews_production_rejected_by_id_users_id_fk"
    FOREIGN KEY ("production_rejected_by_id") REFERENCES "public"."users"("id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pending_reviews_workflow_stage"
  ON "pending_reviews" ("workflow_stage");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pending_reviews_staging_fact"
  ON "pending_reviews" ("staging_fact_id");
--> statement-breakpoint

-- Backfill terminal/triage stages from coarse status. Idempotent: re-running
-- only rewrites rows still at the default that match each status bucket.
-- Approved rows link their live fact as the (now-active) staging fact.
UPDATE "pending_reviews"
   SET "workflow_stage" = 'production_approved',
       "staging_fact_id" = COALESCE("staging_fact_id", "approved_fact_id")
 WHERE "status" = 'approved'
   AND "workflow_stage" = 'triage_pending';
--> statement-breakpoint

UPDATE "pending_reviews"
   SET "workflow_stage" = 'triage_rejected'
 WHERE "status" = 'rejected'
   AND "workflow_stage" = 'triage_pending';
--> statement-breakpoint

-- Pending rows with a completed enrichment blob are production-prep candidates.
-- Mark them production_review here; the TS backfill then attaches a staging fact.
UPDATE "pending_reviews"
   SET "workflow_stage" = 'production_review'
 WHERE "status" = 'pending'
   AND "enrichment_status" = 'ok'
   AND "enrichment" IS NOT NULL
   AND "workflow_stage" = 'triage_pending';
