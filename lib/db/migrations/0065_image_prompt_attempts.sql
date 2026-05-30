-- Phase 2 — per-attempt image prompt generation metadata.
--
-- Each row captures a single render-time image prompt generation attempt:
-- inputs (source-image analysis + identity policy + render controls), the
-- snapshotted fact enrichment, the engine-neutral visualPlan, the
-- engine-specific compiledPrompt, the subject/fact compatibility rating,
-- and (when the chained image_generation job completes) the path of the
-- generated image.
--
-- Lifecycle:
--   1. /memes/ai/:factId/generate-v2 inserts a row with render_job_id
--      populated, visual_plan/compiled_prompt NULL.
--   2. image_prompt_generation handler fills visual_plan + compiled_prompt
--      + subject_fact_compatibility on success (or `error` on failure).
--   3. image_generation handler (chained) fills generated_image_object_path
--      once fal returns.
--   4. The client polls /memes/ai/renders/:render_job_id which reads this
--      row to surface status.
--
-- No retention policy in this PR — low volume during initial rollout. A
-- follow-up may add a sweep after data lands.

CREATE TABLE image_prompt_attempts (
  id BIGSERIAL PRIMARY KEY,
  fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  request_id VARCHAR(128),
  render_job_id VARCHAR(64),                     -- parent client-poll handle (UUID)
  generation_mode VARCHAR(8) NOT NULL,           -- "i2i" | "t2i"
  subject_render_mode VARCHAR(32) NOT NULL,      -- "human_identity_i2i" | "nonhuman_subject_i2i" | "t2i_fallback"
  user_selected_subject_render_mode VARCHAR(32), -- non-null when user overrode the analyzer
  fallback_reason TEXT,                          -- populated when t2i_fallback chosen despite a usable subject
  target_engine VARCHAR(32) NOT NULL,
  source_image_analysis JSONB NOT NULL,
  source_image_sha256 VARCHAR(64),               -- denormalized for fast cache lookup
  identity_policy JSONB NOT NULL,
  render_controls JSONB NOT NULL,
  fact_enrichment_snapshot JSONB NOT NULL,
  archetype_strategy_version VARCHAR(16) NOT NULL,
  visual_plan JSONB,                             -- NULL until prompt-gen succeeds
  compiled_prompt JSONB,                         -- NULL until prompt-gen succeeds
  subject_fact_compatibility JSONB,              -- NULL until prompt-gen succeeds
  error TEXT,                                    -- non-null on failure
  generated_image_object_path TEXT,              -- populated by image_generation handler
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IDX_ipa_fact_id ON image_prompt_attempts(fact_id);
CREATE INDEX IDX_ipa_user_id ON image_prompt_attempts(user_id);
CREATE INDEX IDX_ipa_request_id ON image_prompt_attempts(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IDX_ipa_render_job_id ON image_prompt_attempts(render_job_id) WHERE render_job_id IS NOT NULL;
CREATE INDEX IDX_ipa_created_at ON image_prompt_attempts(created_at DESC);
CREATE INDEX IDX_ipa_subject_render_mode ON image_prompt_attempts(subject_render_mode);
