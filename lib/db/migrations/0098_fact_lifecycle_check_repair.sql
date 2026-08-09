-- Repair migration for the fact-lifecycle DB backstop.
--
-- 0092 added this constraint, but older schema-push runs could remove a
-- hand-authored constraint that had no matching schema.ts declaration after
-- the migration tracker recorded 0092 as applied.  The matching declaration
-- now lives in facts.ts; this forward-only repair restores the constraint in
-- databases that lost it.
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