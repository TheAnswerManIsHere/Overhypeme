-- Add enrichment_status to facts so the admin Facts editor can surface the
-- re-run-classification lifecycle ("pending" | "ok" | "failed"), mirroring
-- pending_reviews.enrichment_status. Nullable: existing facts were never
-- (re)classified in-place. Visual-preview state remains in enrichment.previewStatus.

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "enrichment_status" varchar(16);
