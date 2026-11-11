-- Launch Phase 8: David marks which pictures captured the look style
-- (David, 2026-11-11: "I need a check box that says 'Captured the Style' that I
-- can click next to each image to identify when the AI really understood the
-- style."). Expand only; every existing judgement reads "none marked".
--
-- comparison_picks.style_captured_cell_ids: cells of this panel David marked
--   as having captured its look style; styled panels only.
ALTER TABLE "comparison_picks" ADD COLUMN IF NOT EXISTS "style_captured_cell_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
