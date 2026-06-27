-- Moderation render-scenario metadata + approval waiver.
--
-- PR 1 of the moderation-workflow redesign turns the Step-2 "visual review" into
-- durable, server-side render-scenario orchestration (the old single-shot debug
-- render kept attempt state in browser localStorage). These columns make
-- `image_prompt_attempts` the source of truth for the scenario grid:
--
--   - review_id                     : links a moderation test-render attempt to its review
--   - review_render_scenario_key    : which scenario (generic_t2i / i2i_male_default / …)
--   - review_render_input_hash      : sha256 of canonical render-affecting inputs
--                                     (drives idempotent auto-enqueue + staleness)
--   - review_reference_asset_version: default reference asset version (i2i staleness)
--   - review_reference_identity_type: male | female | nonhuman_animal | nonhuman_object_vehicle
--   - review_render_batch_id        : groups one auto-enqueued default batch (audit)
--
-- All nullable: user-facing render attempts leave them NULL and are unaffected
-- (no backfill). Presentation state (status / stale / latest-for-scenario) is
-- DERIVED at read time, never stored.
--
-- pending_reviews.visual_render_approval_waiver records an admin's explicit,
-- audited waiver when approving despite missing/failed/blocked/stale required
-- scenarios. Null = no waiver needed.

ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "review_id" integer;--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "review_render_scenario_key" varchar(40);--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "review_render_input_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "review_reference_asset_version" varchar(32);--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "review_reference_identity_type" varchar(32);--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "review_render_batch_id" varchar(64);--> statement-breakpoint

-- Keep the moderation attempt even if its review row is hard-deleted (the
-- generated test image remains a valid historical artifact).
ALTER TABLE "image_prompt_attempts"
  ADD CONSTRAINT "image_prompt_attempts_review_id_fk"
  FOREIGN KEY ("review_id")
  REFERENCES "public"."pending_reviews"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- Latest-attempt-per-scenario lookup for the Step-2 grid.
CREATE INDEX IF NOT EXISTS "IDX_ipa_review_scenario_created"
  ON "image_prompt_attempts" ("review_id", "review_render_scenario_key", "created_at" DESC);--> statement-breakpoint

-- Idempotency lookup: has this exact input already been rendered for this review?
CREATE INDEX IF NOT EXISTS "IDX_ipa_review_input_hash"
  ON "image_prompt_attempts" ("review_id", "review_render_input_hash");--> statement-breakpoint

-- Moderation-only partial: scan only the small slice of attempts that belong to
-- a review (the scenario-grid queries never touch user-facing render rows).
CREATE INDEX IF NOT EXISTS "IDX_ipa_review_only"
  ON "image_prompt_attempts" ("review_id")
  WHERE "review_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "pending_reviews" ADD COLUMN IF NOT EXISTS "visual_render_approval_waiver" jsonb;
