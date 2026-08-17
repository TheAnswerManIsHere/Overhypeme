-- Release A (expand) of the `is_estimated` cost-ledger plan
-- (docs/plans/is-estimated-cost-ledger.md, plan reviewed on PR #491,
-- workstream #473).
--
-- ADDITIVE, AND NOTHING ELSE. This migration deliberately does NOT backfill.
--
-- WHY THE BACKFILL IS NOT HERE — and why folding it in later would be a
-- regression, not a tidy-up. `index.ts` runs every pending migration at server
-- startup before the instance listens, so a backfill shipped alongside this
-- column would execute:
--   * BEFORE the writers that populate the flag are deployed;
--   * BEFORE old instances drain — those keep inserting rows with no flag, and
--     since migrations are hash-tracked this one never runs again, so those
--     rows would stay NULL permanently and invisibly; and
--   * with nobody having inspected a dry run first.
-- Classification therefore ships as its own later RELEASE, after the writers,
-- behind an operator-run read-only preflight.
--
-- NULLABLE WITH NO DEFAULT is equally deliberate. Three states must be
-- representable:
--   false -> cost derived from fal's published rate for that endpoint
--   true  -> cost derived from an operator-configured estimate or a hard-coded
--            fallback
--   NULL  -> provenance genuinely unrecoverable for this historical row, or
--            written by a build predating the flag
-- `NOT NULL DEFAULT false` would assert "provider-resolved" for every existing
-- row, including the videoPipelineRunner stage-1/2/3 rows known to be
-- estimates. Recording an unknown as a known is the exact failure this column
-- exists to prevent.
--
-- NOT measured-vs-estimated: no row in this table holds an actual provider
-- charge. Both values are computed — one tracks fal's published rate, the other
-- tracks our own configured guess.
--
-- Backward-compatible: instances running the previous build keep inserting
-- successfully and simply leave the column NULL.
--
-- Source of truth: lib/db/src/schema/falPricing.ts.

ALTER TABLE "user_generation_costs"
  ADD COLUMN IF NOT EXISTS "is_estimated" boolean;

COMMENT ON COLUMN "user_generation_costs"."is_estimated" IS
  'Cost provenance. false = derived from fal''s published rate for the endpoint; true = derived from an operator-configured estimate or hard-coded fallback; NULL = unrecoverable for this historical row, or written by a build predating the flag. NOT measured-vs-estimated: no row holds an actual provider charge. When true, pricing_fetched_at is the write time, not a fetch time.';
