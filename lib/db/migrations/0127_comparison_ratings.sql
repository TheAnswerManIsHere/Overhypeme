-- Launch Phase 8: the engine comparison is judged by rating every image 1 to 5
-- (David, 2026-11-10: "Set up the judging such that each image is rated on a
-- scale of 1 - 5. That way, we can calculate a ranking that makes more
-- sense."), in place of picking the best one. Expand only, on a table that
-- holds no rows anywhere: no panel has been judged (no comparison has rendered).
--
-- comparison_picks.ratings: [{ cellId, score }] — one score per image the panel
--   showed. A rating row names no single "best" cell, so picked_cell_id is no
--   longer required; the column stays for history and is written null.
ALTER TABLE "comparison_picks" ADD COLUMN IF NOT EXISTS "ratings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "comparison_picks" ALTER COLUMN "picked_cell_id" DROP NOT NULL;
