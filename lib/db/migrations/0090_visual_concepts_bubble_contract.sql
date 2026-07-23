-- 0090 (was drafted as 0089; renumbered on merge — PR #228 landed
-- 0089_fact_text_edit_history first).
--
-- Migrate the seeded candidate-concept system prompt to the v2 bubble
-- contract (speech/thought bubble proposals as a REQUIRED structured
-- "bubbles" array on every concept, plus the single-channel scene rules).
--
-- FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT (visualConceptsConfig.ts) only seeds a
-- fresh admin_config row ON CONFLICT DO NOTHING, so a deployed environment
-- with an existing 'fact_visual_concepts_system' row keeps advertising the OLD
-- three-field output shape to the model even after this code ships — while the
-- strict Structured Outputs wire schema now REQUIRES "bubbles" on every
-- concept. An old prompt + new wire is internally contradictory.
--
-- DML-only (no schema change). Idempotent: each UPDATE is gated on the target
-- actually containing the retired shape text; the replace() preserves all
-- other admin edits. Pattern mirrors 0085_visual_concept_leads_system_prompt.

-- ── admin_config.value ─────────────────────────────────────────────────────
UPDATE "admin_config"
SET "value" = replace(
    "value",
    'Produce a JSON object: { "concepts": [ { "title", "whyItWorks", "sceneDescription" } x3 ] }. Exactly three concepts.

Per concept:
- title: a short, scannable label for the idea (e.g. "Courtroom of melting clocks").
- whyItWorks: ONE sentence on why this staging lands the overhype (admin-facing only; never rendered).
- sceneDescription: the "describe the picture" brief — ONE tight paragraph of what is literally in the frame (subject + action + key objects + setting + mood). This is what becomes the render brief, so make it concrete and visual.',
    'Produce a JSON object: { "concepts": [ { "title", "whyItWorks", "sceneDescription", "bubbles" } x3 ] }. Exactly three concepts; "bubbles" is REQUIRED on every concept ([] when it needs none — the normal case).

Per concept:
- title: a short, scannable label for the idea (e.g. "Courtroom of melting clocks").
- whyItWorks: ONE sentence on why this staging lands the overhype (admin-facing only; never rendered).
- sceneDescription: the "describe the picture" brief — ONE tight paragraph of what is literally in the frame (subject + action + key objects + setting + mood). This is what becomes the render brief, so make it concrete and visual.
- bubbles: structured speech/thought bubble proposals — [] unless a bubble materially serves the gag. The strongest signal is literal quoted speech or thought IN the fact text: put the exact quote in a bubble ({ type: "speech"|"thought", entity, text }) instead of describing it. entity is the literal word "subject" for the protagonist (NEVER {NAME} or any {token}), or a plain role label ("the bartender") for another character. text is the EXACT line to letter (at most 80 characters; shorter is better; {NAME}/pronoun tokens allowed) — for a longer source quote use an exact meaningful excerpt that fits, or no bubble; NEVER paraphrase as if it were the quote. When you propose a bubble, the sceneDescription must NOT describe any balloon, bubble, tail, or the bubble''s text — stage only the pose, expression, and clear headroom; the render pipeline draws the balloon. Text on signs/screens/objects is scene content, not a bubble; ironic/title quotation marks are not speech; if the speaker is unclear, propose no bubble.'
)
WHERE "key" = 'fact_visual_concepts_system'
  AND "value" LIKE '%{ "concepts": [ { "title", "whyItWorks", "sceneDescription" } x3 ] }%';

-- ── admin_config.debug_value (NULL-preserving) ─────────────────────────────
UPDATE "admin_config"
SET "debug_value" = CASE
    WHEN "debug_value" IS NULL THEN NULL
    ELSE replace(
        "debug_value",
        'Produce a JSON object: { "concepts": [ { "title", "whyItWorks", "sceneDescription" } x3 ] }. Exactly three concepts.

Per concept:
- title: a short, scannable label for the idea (e.g. "Courtroom of melting clocks").
- whyItWorks: ONE sentence on why this staging lands the overhype (admin-facing only; never rendered).
- sceneDescription: the "describe the picture" brief — ONE tight paragraph of what is literally in the frame (subject + action + key objects + setting + mood). This is what becomes the render brief, so make it concrete and visual.',
        'Produce a JSON object: { "concepts": [ { "title", "whyItWorks", "sceneDescription", "bubbles" } x3 ] }. Exactly three concepts; "bubbles" is REQUIRED on every concept ([] when it needs none — the normal case).

Per concept:
- title: a short, scannable label for the idea (e.g. "Courtroom of melting clocks").
- whyItWorks: ONE sentence on why this staging lands the overhype (admin-facing only; never rendered).
- sceneDescription: the "describe the picture" brief — ONE tight paragraph of what is literally in the frame (subject + action + key objects + setting + mood). This is what becomes the render brief, so make it concrete and visual.
- bubbles: structured speech/thought bubble proposals — [] unless a bubble materially serves the gag. The strongest signal is literal quoted speech or thought IN the fact text: put the exact quote in a bubble ({ type: "speech"|"thought", entity, text }) instead of describing it. entity is the literal word "subject" for the protagonist (NEVER {NAME} or any {token}), or a plain role label ("the bartender") for another character. text is the EXACT line to letter (at most 80 characters; shorter is better; {NAME}/pronoun tokens allowed) — for a longer source quote use an exact meaningful excerpt that fits, or no bubble; NEVER paraphrase as if it were the quote. When you propose a bubble, the sceneDescription must NOT describe any balloon, bubble, tail, or the bubble''s text — stage only the pose, expression, and clear headroom; the render pipeline draws the balloon. Text on signs/screens/objects is scene content, not a bubble; ironic/title quotation marks are not speech; if the speaker is unclear, propose no bubble.'
    )
END
WHERE "key" = 'fact_visual_concepts_system'
  AND "debug_value" LIKE '%{ "concepts": [ { "title", "whyItWorks", "sceneDescription" } x3 ] }%';
