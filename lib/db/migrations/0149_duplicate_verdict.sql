-- Duplicate verdict on a review (plan docs/plans/PLAN_DUPLICATE_VERDICT.md,
-- Issue #1003; approved by David 2026-11-17). Expand only, no backfill.
--
-- pending_reviews.duplicate_outcome    the server's duplicate check of the
--                                      review's CURRENT wording: 'duplicate' |
--                                      'distinct' | 'unavailable'. Null means not
--                                      checked; it is never inferred from
--                                      matching_similarity, including 0.
-- pending_reviews.matching_review_id   the other pending review an exact match
--                                      found (null when the match is a fact).
-- pending_reviews.duplicate_checked_at when the stored result was computed.
--
-- The retired "Duplicate Flag Threshold (%)" setting is deleted: the verdict,
-- not a similarity cut-off, now decides whether a match is shown.
--
-- Row-state matrix:
--   existing reviews        new columns null: read as "Not checked yet" and
--                           checked the first time triage opens them (Q1).
--   rows written by the previous release after this ran
--                           same: nulls, read correctly.
--   admin_config row present / already absent
--                           deleted / no-op.
-- Previous release on this schema: it never reads the new columns, and it reads
-- review_duplicate_threshold through a fallback of 80 when the row is absent.
--
-- Rollback: revert the code and keep the columns (nullable, ignored by the old
-- code); the old seed reinserts the setting. Idempotent: every statement is
-- IF [NOT] EXISTS or a guarded delete.
ALTER TABLE "pending_reviews" ADD COLUMN IF NOT EXISTS "duplicate_outcome" varchar(16);
ALTER TABLE "pending_reviews" ADD COLUMN IF NOT EXISTS "matching_review_id" integer;
ALTER TABLE "pending_reviews" ADD COLUMN IF NOT EXISTS "duplicate_checked_at" timestamp with time zone;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_reviews_duplicate_outcome_check') THEN
    ALTER TABLE "pending_reviews" ADD CONSTRAINT "pending_reviews_duplicate_outcome_check"
      CHECK ("duplicate_outcome" IS NULL OR "duplicate_outcome" IN ('duplicate', 'distinct', 'unavailable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_reviews_matching_review_id_fk') THEN
    ALTER TABLE "pending_reviews" ADD CONSTRAINT "pending_reviews_matching_review_id_fk"
      FOREIGN KEY ("matching_review_id") REFERENCES "pending_reviews"("id") ON DELETE SET NULL;
  END IF;
END $$;
DELETE FROM "admin_config" WHERE "key" = 'review_duplicate_threshold';
