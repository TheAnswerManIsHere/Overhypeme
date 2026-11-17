-- Pictures drawn straight from the approved gag, increment 1 (plan
-- docs/plans/PLAN_GAG_DIRECT_RENDER.md, *Proposed Design* A): a comparison set
-- can compare today's planned path with the direct path, on one selected gag.
-- Expand only; every existing set, panel and cell reads exactly as before.
--
-- comparison_sets.kind gains the value "path" (the column is free text).
-- comparison_sets.gag_ids: the gags a path set draws, chosen per fact; null
--   on every other set, whose panels draw each fact's default gag.
-- comparison_panels.gag_id: the one gag a panel was drawn from; null on
--   panels made earlier (they drew the fact's default gag). A record, with no
--   foreign key: the panel freezes the gag's content itself, and a key would
--   tie fact_gags to the comparison (migration 0139's reverse script drops
--   fact_gags).
-- comparison_panels.gag_cast: the cast extraction frozen for the direct side
--   ({ cast, unboundSpeakers, extraction }); null elsewhere.
-- comparison_panels.frozen_bubbles: the gag's bubbles as the panel expected
--   them, rendered for its subject, shown while judging; null before.
-- comparison_cells.render_path: "planned" or "direct" on a path set; null on
--   every other set. A panel can now hold one cell per engine, version AND
--   path, so the uniqueness widens again.
ALTER TABLE "comparison_sets" ADD COLUMN IF NOT EXISTS "gag_ids" jsonb;
ALTER TABLE "comparison_panels" ADD COLUMN IF NOT EXISTS "gag_id" bigint;
ALTER TABLE "comparison_panels" ADD COLUMN IF NOT EXISTS "gag_cast" jsonb;
ALTER TABLE "comparison_panels" ADD COLUMN IF NOT EXISTS "frozen_bubbles" jsonb;
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "render_path" varchar(16);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comparison_panels_identity_gag" ON "comparison_panels" ("set_id", "fact_id", "scenario_key", "look_style_id", (coalesce("gag_id", 0)));
DROP INDEX IF EXISTS "UQ_comparison_panels_identity";
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comparison_cells_panel_engine_recipe_path" ON "comparison_cells" ("panel_id", "engine_id", (coalesce("recipe_version_id", 0)), (coalesce("render_path", '')));
DROP INDEX IF EXISTS "UQ_comparison_cells_panel_engine_recipe";
