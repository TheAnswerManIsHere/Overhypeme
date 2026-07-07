-- Migrate the seeded image-prompt system prompt to the "Visual Concept leads"
-- section order and identity-clause wording (PR192: compiler redesign where
-- CORE SCENE leads every render mode, ROLE DETAILS replaces REFERENCE
-- INTERPRETATION, and the compiler owns an "identity/reference clause"
-- instead of an "IMAGE-TO-IMAGE TASK" block).
--
-- FACT_IMAGE_PROMPT_SYSTEM_DEFAULT (lib/api-zod's TS default) only seeds a
-- fresh admin_config row ON CONFLICT DO NOTHING, so a deployed environment
-- with an existing 'fact_image_prompt_system' row keeps advertising the OLD
-- contract ("IMAGE-TO-IMAGE TASK" leads, REFERENCE INTERPRETATION exists) to
-- the planner even after this code ships — contradicting what the compiler
-- now actually assembles.
--
-- DML-only (no schema change). Idempotent: each UPDATE is gated on the target
-- actually containing the retired text; the replace() preserves all other
-- admin edits. Pattern mirrors 0084_strip_stale_compatibility_fallback_rule.sql.

-- ── Section-order paragraph ────────────────────────────────────────────────
-- ── admin_config.value ─────────────────────────────────────────────────────
UPDATE "admin_config"
SET "value" = replace(
    "value",
    'The engine prompt is assembled deterministically from a fixed, labeled visual contract:
IMAGE-TO-IMAGE TASK · SUBJECT BINDING · CORE SCENE · SUBJECT DETAILS · ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS. The compiler owns IMAGE-TO-IMAGE TASK, SUBJECT BINDING, and STRICT CONSTRAINTS itself (identity, de-aging binding, anti-split, text policy). YOUR job is to fill the concrete visual fields below with dense, literal, pixel-mapping detail. visualGoal/visualApproach are INTERNAL reasoning only — they are NOT shown to the image model, so do not pack scene detail there.',
    'The engine prompt is assembled deterministically from a labeled visual contract, and the VISUAL CONCEPT (CORE SCENE) LEADS it:
CORE SCENE · IDENTITY/RENDER TASK · SUBJECT BINDING · ROLE DETAILS · SUBJECT DETAILS · ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS. The compiler owns the identity/reference clause, SUBJECT BINDING, and STRICT CONSTRAINTS itself (identity, de-aging binding, anti-split, text policy). Sections after CORE SCENE are additive — they contribute only what the scene omitted. YOUR job is to fill the concrete visual fields below with dense, literal, pixel-mapping detail; coreScene carries the scene. visualGoal/visualApproach are INTERNAL reasoning only — NOT shown to the image model, so do not pack scene detail there.'
)
WHERE "key" = 'fact_image_prompt_system'
  AND "value" LIKE '%IMAGE-TO-IMAGE TASK · SUBJECT BINDING · CORE SCENE%';

-- ── admin_config.debug_value (NULL-preserving) ─────────────────────────────
UPDATE "admin_config"
SET "debug_value" = CASE
    WHEN "debug_value" IS NULL THEN NULL
    ELSE replace(
        "debug_value",
        'The engine prompt is assembled deterministically from a fixed, labeled visual contract:
IMAGE-TO-IMAGE TASK · SUBJECT BINDING · CORE SCENE · SUBJECT DETAILS · ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS. The compiler owns IMAGE-TO-IMAGE TASK, SUBJECT BINDING, and STRICT CONSTRAINTS itself (identity, de-aging binding, anti-split, text policy). YOUR job is to fill the concrete visual fields below with dense, literal, pixel-mapping detail. visualGoal/visualApproach are INTERNAL reasoning only — they are NOT shown to the image model, so do not pack scene detail there.',
        'The engine prompt is assembled deterministically from a labeled visual contract, and the VISUAL CONCEPT (CORE SCENE) LEADS it:
CORE SCENE · IDENTITY/RENDER TASK · SUBJECT BINDING · ROLE DETAILS · SUBJECT DETAILS · ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS. The compiler owns the identity/reference clause, SUBJECT BINDING, and STRICT CONSTRAINTS itself (identity, de-aging binding, anti-split, text policy). Sections after CORE SCENE are additive — they contribute only what the scene omitted. YOUR job is to fill the concrete visual fields below with dense, literal, pixel-mapping detail; coreScene carries the scene. visualGoal/visualApproach are INTERNAL reasoning only — NOT shown to the image model, so do not pack scene detail there.'
    )
  END
WHERE "key" = 'fact_image_prompt_system'
  AND "debug_value" LIKE '%IMAGE-TO-IMAGE TASK · SUBJECT BINDING · CORE SCENE%';

-- ── Rule 4 (identity language ownership) ───────────────────────────────────
-- ── admin_config.value ─────────────────────────────────────────────────────
UPDATE "admin_config"
SET "value" = replace(
    "value",
    '4. Identity language is OWNED BY THE COMPILER. Do NOT author face/identity-preservation, reference-image, or de-aging language in coreScene/subjectDetails/environment/compiledPrompt — the compiler injects the IMAGE-TO-IMAGE TASK and SUBJECT BINDING blocks (transformation-aware identity preservation + the de-aging/anti-split binding) itself, and strips any you write. Instead, signal the transform via subjectTreatment.ageLifeStageTransform and DESCRIBE the transformed subject concretely in subjectDetails (e.g. "infant proportions, chubby cheeks, wispy hair").',
    '4. Identity language is OWNED BY THE COMPILER. Do NOT author face/identity-preservation, reference-image, or de-aging language in coreScene/subjectDetails/environment/compiledPrompt — the compiler injects the identity/reference clause and SUBJECT BINDING blocks (transformation-aware identity preservation + the de-aging/anti-split binding) itself, and strips any you write. Instead, signal the transform via subjectTreatment.ageLifeStageTransform and DESCRIBE the transformed subject concretely in subjectDetails (e.g. "infant proportions, chubby cheeks, wispy hair").'
)
WHERE "key" = 'fact_image_prompt_system'
  AND "value" LIKE '%the compiler injects the IMAGE-TO-IMAGE TASK and SUBJECT BINDING blocks%';

-- ── admin_config.debug_value (NULL-preserving) ─────────────────────────────
UPDATE "admin_config"
SET "debug_value" = CASE
    WHEN "debug_value" IS NULL THEN NULL
    ELSE replace(
        "debug_value",
        '4. Identity language is OWNED BY THE COMPILER. Do NOT author face/identity-preservation, reference-image, or de-aging language in coreScene/subjectDetails/environment/compiledPrompt — the compiler injects the IMAGE-TO-IMAGE TASK and SUBJECT BINDING blocks (transformation-aware identity preservation + the de-aging/anti-split binding) itself, and strips any you write. Instead, signal the transform via subjectTreatment.ageLifeStageTransform and DESCRIBE the transformed subject concretely in subjectDetails (e.g. "infant proportions, chubby cheeks, wispy hair").',
        '4. Identity language is OWNED BY THE COMPILER. Do NOT author face/identity-preservation, reference-image, or de-aging language in coreScene/subjectDetails/environment/compiledPrompt — the compiler injects the identity/reference clause and SUBJECT BINDING blocks (transformation-aware identity preservation + the de-aging/anti-split binding) itself, and strips any you write. Instead, signal the transform via subjectTreatment.ageLifeStageTransform and DESCRIBE the transformed subject concretely in subjectDetails (e.g. "infant proportions, chubby cheeks, wispy hair").'
    )
  END
WHERE "key" = 'fact_image_prompt_system'
  AND "debug_value" LIKE '%the compiler injects the IMAGE-TO-IMAGE TASK and SUBJECT BINDING blocks%';
