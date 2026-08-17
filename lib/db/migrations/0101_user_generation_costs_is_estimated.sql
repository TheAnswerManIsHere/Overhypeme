-- Release A (expand) of the `is_estimated` cost-ledger plan
-- Approved-plan source: plan-review PR #491, final plan commit
-- df26461ea0a7108e70aaeed3cd31a5f9475124a5, approved by David on 2026-08-17.
-- Workstream #473.
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
-- THIS MIGRATION IS NOT SUFFICIENT ON ITS OWN, AND THAT IS NOT AN OVERSIGHT.
-- `user_generation_costs` is created by `ensureSchema()` (api-server
-- lib/seed.ts), not by any migration, and `index.ts` runs `runMigrations()`
-- BEFORE `ensureSchema()`. On a fresh or partial database the table therefore
-- does not exist when this runs, and the statement below raises 42P01
-- (`undefined_table`) — note that `IF NOT EXISTS` guards the COLUMN, not the
-- TABLE. The runner treats 42P01 as an idempotency success and records this
-- migration's hash, so it never retries; `ensureSchema()` would then create the
-- table and the column would be absent forever.
--
-- The column is therefore ALSO declared in `ensureSchema()`'s CREATE TABLE, and
-- carries its own ADD COLUMN IF NOT EXISTS entry there. Fresh databases get it
-- from the seed; existing ones get it from this migration. Both paths converge
-- on the same schema. Removing either half reopens the gap.
--
-- Source of truth: lib/db/src/schema/falPricing.ts.

ALTER TABLE "user_generation_costs"
  ADD COLUMN IF NOT EXISTS "is_estimated" boolean;

COMMENT ON COLUMN "user_generation_costs"."is_estimated" IS
  'Cost provenance. false = derived from fal''s published rate for the endpoint; true = derived from an operator-configured estimate or hard-coded fallback; NULL = unrecoverable for this historical row, or written by a build predating the flag. NOT measured-vs-estimated: no row holds an actual provider charge. When true, pricing_fetched_at is the write time, not a fetch time.';
