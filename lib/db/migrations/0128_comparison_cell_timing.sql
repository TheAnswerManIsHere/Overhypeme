-- Launch Phase 8: how long each engine takes to draw a picture (David,
-- 2026-11-10: "If one engine can render an image in 10 seconds and another one
-- takes 2 minutes, that's going to be important to know."). Expand only, on a
-- table no comparison has rendered into yet.
--
-- comparison_cells.submitted_at: when this cell's one request was sent to fal.
-- comparison_cells.completed_at: when fal returned the image. The difference is
--   the wait a caller sees: fal's queue plus the drawing. Both are cleared by
--   the one re-run a failed cell is allowed.
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
