-- Add the `concept_review` stage (Step 2: Visual Concept gate) to the
-- review_workflow_stage enum, between `prep_failed` and `production_review`.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction on older Postgres and
-- the hash-based migration runner wraps each migration file in one transaction
-- (see lib/db/src/migrate.ts), so — matching the 0027 precedent — we recreate
-- the enum via a temporary text cast instead. The enum is used by exactly one
-- column (pending_reviews.workflow_stage), so the recast is contained.
--
-- No backfill (D3): existing `production_review` rows stay at Step 3 under the
-- old-flow treatment; their string value is preserved verbatim through the cast.
-- Fully idempotent: the whole file re-runs cleanly because it drops and rebuilds
-- the type from scratch each time.

-- Drop the default so the column can drop its enum dependency.
ALTER TABLE "pending_reviews"
  ALTER COLUMN "workflow_stage" DROP DEFAULT;
--> statement-breakpoint

-- Convert the column to text, releasing the enum type. The idx_pending_reviews_
-- workflow_stage index is rebuilt automatically by the type change.
ALTER TABLE "pending_reviews"
  ALTER COLUMN "workflow_stage" TYPE text
  USING "workflow_stage"::text;
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."review_workflow_stage";
--> statement-breakpoint

CREATE TYPE "public"."review_workflow_stage" AS ENUM(
  'triage_pending',
  'triage_rejected',
  'prep_pending',
  'prep_failed',
  'concept_review',
  'production_review',
  'production_rejected',
  'production_approved'
);
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ALTER COLUMN "workflow_stage" TYPE "public"."review_workflow_stage"
  USING "workflow_stage"::"public"."review_workflow_stage";
--> statement-breakpoint

ALTER TABLE "pending_reviews"
  ALTER COLUMN "workflow_stage" SET DEFAULT 'triage_pending';
