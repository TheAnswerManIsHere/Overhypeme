-- Retire the stale "poor compatibility requires a non-none recommendedFallback"
-- instruction from the admin-configurable image-prompt system prompt.
--
-- subjectFactCompatibility no longer gates rendering (the job-level block on
-- rating="poor" was removed — facts are manually curated, so a render proceeds
-- even when the planner rates the pairing poorly; the rating is advisory-only,
-- surfaced for admin visibility). Telling the model "Never 'none' for a poor
-- rating" now contradicts that: the field is advisory, and "none" is valid for
-- every rating. See lib/api-zod/src/imagePromptGeneration.ts (validator rule 12
-- retired) and artifacts/api-server/src/lib/imagePromptJobs.ts
-- (persistImagePromptPlanAndEnqueueGeneration always enqueues image_generation).
--
-- DML-only (no schema change). Idempotent: gated on the target actually
-- containing the retired line; the replace() preserves all other admin edits.
-- fact_image_prompt_system is seeded ON CONFLICT DO NOTHING, so without this an
-- existing admin_config row keeps advertising the retired hard-fallback rule.
-- Pattern mirrors 0082_strip_retired_text_modifiers.sql.

-- ── admin_config.value ─────────────────────────────────────────────────────
UPDATE "admin_config"
SET "value" = replace(
    "value",
    '11. subjectFactCompatibility: rate strong / workable / risky / poor based on whether the uploaded subject CAN sell this specific fact. When rating is "poor", recommendedFallback MUST be one of t2i_fallback / upload_human_photo / choose_different_fact. Never "none" for a poor rating.',
    '11. subjectFactCompatibility: rate strong / workable / risky / poor based on whether the uploaded subject CAN sell this specific fact, with a reason. recommendedFallback is advisory only; "none" is valid for every rating, including poor. This field never blocks rendering.'
)
WHERE "key" = 'fact_image_prompt_system'
  AND "value" LIKE '%Never "none" for a poor rating.%';

-- ── admin_config.debug_value (NULL-preserving) ─────────────────────────────
UPDATE "admin_config"
SET "debug_value" = CASE
    WHEN "debug_value" IS NULL THEN NULL
    ELSE replace(
        "debug_value",
        '11. subjectFactCompatibility: rate strong / workable / risky / poor based on whether the uploaded subject CAN sell this specific fact. When rating is "poor", recommendedFallback MUST be one of t2i_fallback / upload_human_photo / choose_different_fact. Never "none" for a poor rating.',
        '11. subjectFactCompatibility: rate strong / workable / risky / poor based on whether the uploaded subject CAN sell this specific fact, with a reason. recommendedFallback is advisory only; "none" is valid for every rating, including poor. This field never blocks rendering.'
    )
  END
WHERE "key" = 'fact_image_prompt_system'
  AND "debug_value" LIKE '%Never "none" for a poor rating.%';
