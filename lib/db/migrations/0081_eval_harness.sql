-- Eval harness (Slice 2B): a golden set, a per-render moderator rating +
-- failure-tag, and controlled before/after "eval runs" so we can tell whether a
-- pipeline change actually moved render quality.
--
-- Hand-written idempotent DDL per repo migration discipline (drizzle-kit generate
-- is broken on the pre-existing malformed 0063 snapshot, so this ships without a
-- generated snapshot; the hash-based runner treats already-exists DDL as
-- pre-applied). Source of truth: lib/db/src/schema/{imagePromptAttempts,facts,evalRuns}.ts.

-- ── eval_runs: one controlled batch render of the golden set ──────────────────
CREATE TABLE IF NOT EXISTS "eval_runs" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "label" text,
    -- Broad pipeline profile captured ONCE per run (planner engine/model/effort,
    -- imagePromptGenerationVersion, scenario-config version, archetype strategy
    -- version). Attempt-level signatures live on image_prompt_attempts.
    "run_profile" jsonb,
    "created_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── image_prompt_attempts: moderator eval + eval-run tagging ──────────────────
-- rating / failure_tag / notes are the moderator's verdict on a render; they
-- apply to BOTH ordinary moderation attempts (opportunistic, directional-only)
-- and eval-run attempts (a true A/B). eval_run_id / eval_scenario_key /
-- eval_input_hash are set ONLY on eval-run attempts (review_id stays NULL there,
-- so eval renders never appear in the moderation grid).
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "moderator_rating" smallint;
--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "failure_tag" varchar(16);
--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "eval_notes" text;
--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "eval_by" varchar;
--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "eval_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "eval_run_id" bigint REFERENCES "eval_runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "eval_scenario_key" varchar(40);
--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "eval_input_hash" text;
--> statement-breakpoint

-- Dashboard queries: group a run's attempts by fact, and a fact's attempts by
-- run. Partial (eval_run_id IS NOT NULL) so these never bloat with the millions
-- of user/moderation attempts.
CREATE INDEX IF NOT EXISTS "IDX_ipa_eval_run_fact_created"
    ON "image_prompt_attempts" ("eval_run_id","fact_id","created_at" DESC)
    WHERE "eval_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_ipa_eval_fact_run_created"
    ON "image_prompt_attempts" ("fact_id","eval_run_id","created_at" DESC)
    WHERE "eval_run_id" IS NOT NULL;
--> statement-breakpoint

-- ── facts: golden set (active facts only, in practice) ────────────────────────
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "eval_golden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "eval_golden_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_facts_eval_golden" ON "facts" ("id") WHERE "eval_golden";
