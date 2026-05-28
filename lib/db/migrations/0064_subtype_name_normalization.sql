-- Phase 2A: normalize logic_formal_impossibility subtype names.
--
-- The Phase 2A visual prompt strategy map drops `zero_division_impossibility`
-- as a standalone subtype (divide-by-zero now folds under the paradox bucket)
-- and renames `paradox_impossibility` -> `paradox_or_undefined_impossibility`.
-- Both legacy names now map to a single canonical bucket.
--
-- Source-of-truth changes:
--   - lib/api-zod/src/taxonomy.ts: removed `zero_division_impossibility` and
--     renamed `paradox_impossibility` -> `paradox_or_undefined_impossibility`
--     in SUBTYPES_BY_ARCHETYPE.logic_formal_impossibility.
--
-- This migration normalizes any already-stored references so they match the
-- new vocabulary. Two surface areas carry subtype values:
--   1. facts.subtype (promoted column added in 0062)
--   2. facts.enrichment->>'subtype' and pending_reviews.enrichment->>'subtype'
--      (the JSON blob field)
--
-- Pure DML — no schema delta. Listed in SNAPSHOT_EXEMPT_TAGS in
-- lib/db/scripts/check-migration-snapshots.ts.

-- 1. Promoted column on facts.
UPDATE facts
SET subtype = 'paradox_or_undefined_impossibility'
WHERE subtype IN ('zero_division_impossibility', 'paradox_impossibility');

-- 2. JSON blob on facts.
UPDATE facts
SET enrichment = jsonb_set(
      enrichment,
      '{subtype}',
      '"paradox_or_undefined_impossibility"'::jsonb,
      false
    )
WHERE enrichment IS NOT NULL
  AND enrichment->>'subtype' IN ('zero_division_impossibility', 'paradox_impossibility');

-- 3. JSON blob on pending_reviews.
UPDATE pending_reviews
SET enrichment = jsonb_set(
      enrichment,
      '{subtype}',
      '"paradox_or_undefined_impossibility"'::jsonb,
      false
    )
WHERE enrichment IS NOT NULL
  AND enrichment->>'subtype' IN ('zero_division_impossibility', 'paradox_impossibility');

-- 4. Surgically patch the seeded enrichment system prompt if Phase 1 left the
--    old subtype names in admin_config. Surgical (REPLACE) rather than blanket
--    overwrite so any admin customization elsewhere in the prompt survives.
UPDATE admin_config
SET value = REPLACE(value, E'- zero_division_impossibility\n', '')
WHERE key = 'fact_enrichment_system'
  AND value LIKE '%zero_division_impossibility%';

UPDATE admin_config
SET value = REPLACE(value, '- paradox_impossibility', '- paradox_or_undefined_impossibility')
WHERE key = 'fact_enrichment_system'
  AND value LIKE '%paradox_impossibility%'
  AND value NOT LIKE '%paradox_or_undefined_impossibility%';

-- Same surgical fix for the debug_value override, if set.
UPDATE admin_config
SET debug_value = REPLACE(debug_value, E'- zero_division_impossibility\n', '')
WHERE key = 'fact_enrichment_system'
  AND debug_value IS NOT NULL
  AND debug_value LIKE '%zero_division_impossibility%';

UPDATE admin_config
SET debug_value = REPLACE(debug_value, '- paradox_impossibility', '- paradox_or_undefined_impossibility')
WHERE key = 'fact_enrichment_system'
  AND debug_value IS NOT NULL
  AND debug_value LIKE '%paradox_impossibility%'
  AND debug_value NOT LIKE '%paradox_or_undefined_impossibility%';
