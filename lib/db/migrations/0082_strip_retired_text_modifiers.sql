-- Retire the auto-applied text/brand suppression modifiers `no_readable_text`,
-- `avoid_readable_ui`, and `avoid_real_logos` from the admin-configurable
-- classifier prompt, so the AI stops advertising (and emitting) a blanket "no
-- readable text" ban that contradicts intentional in-scene text. The concerns
-- now have single owners: incidental-text gibberish is an always-on yielding
-- line in the compiler's supporting-text rules; a full in-scene text ban is the
-- moderator's supportingTextPolicyOverride (mode "forbid"); logos/brand marks
-- are always banned by the overlay-text exclusion.
--
-- DML-only (no schema change). Deliberately does NOT strip stored fact/override
-- enrichment blobs (unlike 0073): a legacy modifier string is now inert — it is
-- filtered out of planner context AND the render-scenario hash in code, so it
-- affects nothing at runtime and remains only as display-only provenance.
--
-- Idempotent: gated on the target actually containing one of the retired lines;
-- the replace() chain removes exact full lines and preserves all other admin
-- edits. The fact-enrichment system prompt is seeded ON CONFLICT DO NOTHING, so
-- without this an existing admin_config row keeps advertising the retired names.

-- ── admin_config.value ─────────────────────────────────────────────────────
UPDATE "admin_config"
SET "value" = replace(replace(replace(
    "value",
    E'- no_readable_text\n', ''),
    E'- avoid_real_logos\n', ''),
    E'- avoid_readable_ui\n', '')
WHERE "key" = 'fact_enrichment_system'
  AND ( "value" LIKE '%- no_readable_text%'
     OR "value" LIKE '%- avoid_real_logos%'
     OR "value" LIKE '%- avoid_readable_ui%' );

-- ── admin_config.debug_value (NULL-preserving) ─────────────────────────────
UPDATE "admin_config"
SET "debug_value" = CASE
    WHEN "debug_value" IS NULL THEN NULL
    ELSE replace(replace(replace(
        "debug_value",
        E'- no_readable_text\n', ''),
        E'- avoid_real_logos\n', ''),
        E'- avoid_readable_ui\n', '')
  END
WHERE "key" = 'fact_enrichment_system'
  AND ( "debug_value" LIKE '%- no_readable_text%'
     OR "debug_value" LIKE '%- avoid_real_logos%'
     OR "debug_value" LIKE '%- avoid_readable_ui%' );
