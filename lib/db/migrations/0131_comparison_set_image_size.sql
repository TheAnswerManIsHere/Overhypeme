-- Launch Phase 8: a comparison set can draw its pictures at the size members
-- get (David, 2026-11-11: "let's render images at the same resolution that
-- users get so we get accurate pricing"). Expand only; every existing set
-- keeps the comparison size it was drawn at.
--
-- comparison_sets.image_size: "comparison" (about 1 megapixel, the
--   evaluation's frozen size) or "final" (about 4 megapixels, a member's
--   render). Read by each cell's request when it is sent.
ALTER TABLE "comparison_sets" ADD COLUMN IF NOT EXISTS "image_size" varchar(16) NOT NULL DEFAULT 'comparison';
