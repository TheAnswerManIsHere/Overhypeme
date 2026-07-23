-- Phase 2 fact-lifecycle closure — PART 2 of 2: GRANDFATHER BACKFILL + CHECK.
--
-- Runs AFTER 0091 (additive schema) and after the writer-closure code has shipped
-- (activateFact chokepoint, ingestion funnel, variant reroute, admin-PATCH
-- activation reject, VSO-preserving enrichment rewriters). At that point no code
-- path can create a fresh `is_active = true, concept-less` row, so it is safe to
-- (1) make every existing active row concept-valid, then (2) add the CHECK VALID.
--
-- Migrations apply at startup in order, before serving, under the writer-closed
-- image (runMigrations() in the api-server entry) — so there is no rolling-deploy
-- window in which an old writer could insert a violator between the backfill and
-- ADD CONSTRAINT.
--
-- "Valid enrichment" proxy: a fact that went through real enrichment ALWAYS has
-- its projected `primary_archetype` column populated (materializeEnrichment writes
-- it). So `primary_archetype IS NULL` (or `enrichment IS NULL`) reliably marks a
-- row that was never validly enriched — the null/invalid-enrichment case David
-- decided to DEACTIVATE + re-moderate (it cannot be made render-valid by stamping
-- a concept). A row WITH a populated projection but no scene is the
-- grandfather-sentinel case: stamp the placeholder Visual Concept and keep it live.
--
-- Idempotent: every step filters on the state it changes, so a re-run is a no-op.

DO $$
DECLARE
  v_deactivated int;
  v_orphans int;
  v_sentinel int;
BEGIN
  -- 1. Deactivate active facts with NO valid materialized enrichment (null OR
  --    invalid/unmaterialized — no projection). David-decided: deactivate +
  --    re-moderate; a fabricated concept can't make them render-valid.
  UPDATE "facts" SET "is_active" = false
  WHERE "is_active" = true
    AND ("primary_archetype" IS NULL OR "enrichment" IS NULL);
  GET DIAGNOSTICS v_deactivated = ROW_COUNT;

  -- 2. Orphan sweep (atomic + rerunnable): deactivate any active fact whose parent
  --    is now inactive, so no live variant is stranded under an inactive root.
  --    Variants are one level deep (parent is always a root); a single pass covers
  --    the model and re-runs to a no-op once none remain.
  UPDATE "facts" SET "is_active" = false
  WHERE "is_active" = true
    AND "parent_id" IN (SELECT "id" FROM "facts" WHERE "is_active" = false);
  GET DIAGNOSTICS v_orphans = ROW_COUNT;

  -- 3. Grandfather sentinel: stamp the placeholder Visual Concept into remaining
  --    active facts that have a valid enrichment but no scene. Ensures the VSO
  --    object exists (forcing version = 1), then sets coreSceneOverride. Matches
  --    blank/absent scene, not "equals sentinel," so a partial re-run completes.
  UPDATE "facts" SET "enrichment" = jsonb_set(
    jsonb_set(
      "enrichment",
      '{visualPromptStrategyOverride}',
      COALESCE("enrichment" -> 'visualPromptStrategyOverride', '{}'::jsonb) || '{"version":1}'::jsonb,
      true
    ),
    '{visualPromptStrategyOverride,coreSceneOverride}',
    to_jsonb('{NAME} stands there confidently.'::text),
    true
  )
  WHERE "is_active" = true
    AND "enrichment" IS NOT NULL
    AND "primary_archetype" IS NOT NULL
    AND COALESCE(
          jsonb_typeof("enrichment" #> '{visualPromptStrategyOverride,coreSceneOverride}') = 'string'
            AND ("enrichment" #>> '{visualPromptStrategyOverride,coreSceneOverride}') ~ '\S',
          false
        ) = false;
  GET DIAGNOSTICS v_sentinel = ROW_COUNT;

  RAISE NOTICE '[0092] fact-lifecycle grandfather backfill: deactivated_no_valid_enrichment=%, orphan_children_deactivated=%, sentinel_concept_stamped=%',
    v_deactivated, v_orphans, v_sentinel;
END $$;

-- 4. DB backstop — the active-requires-concept CHECK, added VALID (the backfill
--    above left zero violators). A CHECK passes on UNKNOWN, so the naive
--    `(#>> …) ~ '\S'` would ACCEPT a null/absent-path active row; the
--    COALESCE(…, false) collapses every NULL case to rejected, and
--    jsonb_typeof(…) = 'string' mirrors the app's validated-string gate so a
--    non-string JSON scalar can't slip through `#>>`. `~ '\S'` = the app's
--    non-empty (.trim()) semantics. Guarded for idempotent re-run.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facts_active_requires_concept'
  ) THEN
    ALTER TABLE "facts" ADD CONSTRAINT "facts_active_requires_concept"
      CHECK (
        "is_active" = false
        OR COALESCE(
             jsonb_typeof("enrichment" #> '{visualPromptStrategyOverride,coreSceneOverride}') = 'string'
               AND ("enrichment" #>> '{visualPromptStrategyOverride,coreSceneOverride}') ~ '\S',
             false
           )
      );
  END IF;
END $$;
