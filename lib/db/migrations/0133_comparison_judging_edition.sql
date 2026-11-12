-- Launch Phase 8, prompt tuner part 1 (plan docs/plans/PLAN_PROMPT_TUNER.md,
-- *Proposed Design* B and C): the second judging edition. Expand only; every
-- existing set, panel and judgement reads exactly as before.
--
-- comparison_sets.judging_edition: 1 for every set that exists today (one
--   1-to-5 score per picture, face and style marks); 2 for every set created
--   from now on (five category scores, an overall pick and a broken flag).
-- comparison_panels.frozen_fact_text / frozen_gag: the fact's wording and its
--   approved visual gag as they stood when the panel was prepared, so a later
--   edit to the fact never changes what a panel is judged against. Null on
--   panels prepared before this migration.
-- comparison_picks.category_scores: the second edition's scores,
--   { cellId, visualQuality, gagFidelity, realism, styleInterpretation?, likeness? }[].
-- comparison_picks.broken_cell_ids: pictures marked broken.
-- The second edition's overall pick reuses comparison_picks.picked_cell_id.
ALTER TABLE "comparison_sets" ADD COLUMN IF NOT EXISTS "judging_edition" smallint DEFAULT 1 NOT NULL;
ALTER TABLE "comparison_sets" ALTER COLUMN "judging_edition" SET DEFAULT 2;
ALTER TABLE "comparison_panels" ADD COLUMN IF NOT EXISTS "frozen_fact_text" text;
ALTER TABLE "comparison_panels" ADD COLUMN IF NOT EXISTS "frozen_gag" text;
ALTER TABLE "comparison_picks" ADD COLUMN IF NOT EXISTS "category_scores" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "comparison_picks" ADD COLUMN IF NOT EXISTS "broken_cell_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
