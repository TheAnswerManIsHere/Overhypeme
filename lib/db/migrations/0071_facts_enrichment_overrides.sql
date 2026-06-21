-- AI-derived vs. manual-override tracking for fact taxonomy enrichment.
--
-- `facts.enrichment` becomes the MATERIALIZED EFFECTIVE blob (AI baseline +
-- manual overrides + preserved visual override) that runtime reads. The new
-- columns preserve the layers it is materialized from:
--   * enrichment_ai_derived — the immutable, pure AI baseline blob.
--   * enrichment_overrides  — path-keyed manual overrides ({} = none).
--   * enrichment_baseline_changed — denormalized "a standing override's AI
--       baseline has since changed" flag, for cheap admin list filtering.
--
-- Backfill limitation (intentional, NOT self-correcting): pre-migration manual
-- edits were written in place to `enrichment` and cannot be distinguished from
-- AI output. We therefore treat the current `enrichment` as the AI baseline.
-- Those legacy manual edits are NOT recoverable as overrides automatically; on
-- the next re-enrich only new path-keyed overrides remain sticky.

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "enrichment_ai_derived" jsonb;
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "enrichment_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "enrichment_baseline_changed" boolean NOT NULL DEFAULT false;

-- Backfill the AI baseline from the current effective blob (best available).
UPDATE "facts"
   SET "enrichment_ai_derived" = "enrichment"
 WHERE "enrichment" IS NOT NULL
   AND "enrichment_ai_derived" IS NULL;

-- Partial index so the admin "has overrides" filter stays cheap.
CREATE INDEX IF NOT EXISTS "facts_has_overrides_idx"
    ON "facts" ("id")
 WHERE "enrichment_overrides" <> '{}'::jsonb;
