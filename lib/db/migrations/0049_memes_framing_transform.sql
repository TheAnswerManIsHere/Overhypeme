-- Phase 3 follow-up: persist client-side canvas pan offsets so server-side
-- renders, Zazzle exports, and cached previews honor the creator's framing.
--
-- Stored as { offsetX, offsetY } in pixels, applied by centerCropParams in
-- artifacts/api-server/src/lib/memeGenerator.ts. NULL means "use the default
-- centered crop", which is what every existing row gets.
--
-- This column is intentionally separate from `image_transform` (added in
-- 0048_meme_builder_lineage) — that one is a varchar(24) analytics enum
-- ('pulid' | 'pulid_fallback_text' | NULL) recording WHETHER the image was
-- AI-stylized. The framing_transform column records HOW it was framed.

ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "framing_transform" jsonb;
