-- The prompt tuner, part 2 (plan docs/plans/PLAN_PROMPT_TUNER.md, *Proposed
-- Design* B): a comparison set can compare prompt wording on one engine.
-- Expand only; every existing set, panel and cell reads exactly as before.
--
-- comparison_sets.kind: "engine" (every set so far: several engines, one
--   wording each) or "prompt" (one engine family, several recipe versions).
-- comparison_sets.recipe_version_ids: a prompt set's versions, 0 for the
--   baseline; null on an engine set.
-- comparison_panels.compile_args: the panel's frozen planner output and
--   inputs, so each cell compiles the same scene with its own wording. Null on
--   panels prepared earlier, which keep their one compiled prompt.
-- comparison_cells.recipe_version_id: the wording a cell is drawn with (null
--   is the baseline); comparison_cells.prompt_text: the exact prompt it sent.
-- A panel can now hold one cell per engine AND version, so the uniqueness
-- widens from (panel, engine) to (panel, engine, version).
ALTER TABLE "comparison_sets" ADD COLUMN IF NOT EXISTS "kind" varchar(16) DEFAULT 'engine' NOT NULL;
ALTER TABLE "comparison_sets" ADD COLUMN IF NOT EXISTS "recipe_version_ids" jsonb;
ALTER TABLE "comparison_panels" ADD COLUMN IF NOT EXISTS "compile_args" jsonb;
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "recipe_version_id" bigint;
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "prompt_text" text;
DO $$ BEGIN
  ALTER TABLE "comparison_cells" ADD CONSTRAINT "comparison_cells_recipe_version_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "prompt_recipe_versions"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comparison_cells_panel_engine_recipe" ON "comparison_cells" ("panel_id", "engine_id", (coalesce("recipe_version_id", 0)));
DROP INDEX IF EXISTS "UQ_comparison_cells_panel_engine";
