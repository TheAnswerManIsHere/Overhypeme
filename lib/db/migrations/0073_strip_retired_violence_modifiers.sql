-- Retire the auto-sanitizing violence modifiers `avoid_gore` / `non_graphic_action`
-- from all stored runtime data + the admin-configurable classifier prompt, so the
-- removed concept cannot survive through enrichment blobs, overrides, or config.
--
-- DML-only (no schema change). Idempotent: every statement is gated on the target
-- actually containing a retired term, and array rebuilds preserve modifier order
-- (jsonb_agg ... ORDER BY ord). All-removed arrays collapse to '[]'.

-- ── 1. facts.enrichment.modifiers ──────────────────────────────────────────
UPDATE "facts"
SET "enrichment" = jsonb_set("enrichment", '{modifiers}', (
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements("enrichment"->'modifiers') WITH ORDINALITY AS e(value, ord)
  WHERE e.value #>> '{}' NOT IN ('avoid_gore', 'non_graphic_action')
))
WHERE jsonb_typeof("enrichment"->'modifiers') = 'array'
  AND ("enrichment"->'modifiers' @> '["avoid_gore"]'::jsonb
       OR "enrichment"->'modifiers' @> '["non_graphic_action"]'::jsonb);

-- ── 2. facts.enrichment_ai_derived.modifiers ───────────────────────────────
UPDATE "facts"
SET "enrichment_ai_derived" = jsonb_set("enrichment_ai_derived", '{modifiers}', (
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements("enrichment_ai_derived"->'modifiers') WITH ORDINALITY AS e(value, ord)
  WHERE e.value #>> '{}' NOT IN ('avoid_gore', 'non_graphic_action')
))
WHERE jsonb_typeof("enrichment_ai_derived"->'modifiers') = 'array'
  AND ("enrichment_ai_derived"->'modifiers' @> '["avoid_gore"]'::jsonb
       OR "enrichment_ai_derived"->'modifiers' @> '["non_graphic_action"]'::jsonb);

-- ── 3. facts.enrichment_overrides['/modifiers'].value ──────────────────────
UPDATE "facts"
SET "enrichment_overrides" = jsonb_set("enrichment_overrides", '{/modifiers,value}', (
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements("enrichment_overrides" #> '{/modifiers,value}') WITH ORDINALITY AS e(value, ord)
  WHERE e.value #>> '{}' NOT IN ('avoid_gore', 'non_graphic_action')
))
WHERE jsonb_typeof("enrichment_overrides" #> '{/modifiers,value}') = 'array'
  AND ("enrichment_overrides" #> '{/modifiers,value}' @> '["avoid_gore"]'::jsonb
       OR "enrichment_overrides" #> '{/modifiers,value}' @> '["non_graphic_action"]'::jsonb);

-- ── 4. facts.enrichment_overrides['/modifiers'].overriddenFrom ─────────────
-- (so baseline-change detection no longer compares against a retired AI value)
UPDATE "facts"
SET "enrichment_overrides" = jsonb_set("enrichment_overrides", '{/modifiers,overriddenFrom}', (
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements("enrichment_overrides" #> '{/modifiers,overriddenFrom}') WITH ORDINALITY AS e(value, ord)
  WHERE e.value #>> '{}' NOT IN ('avoid_gore', 'non_graphic_action')
))
WHERE jsonb_typeof("enrichment_overrides" #> '{/modifiers,overriddenFrom}') = 'array'
  AND ("enrichment_overrides" #> '{/modifiers,overriddenFrom}' @> '["avoid_gore"]'::jsonb
       OR "enrichment_overrides" #> '{/modifiers,overriddenFrom}' @> '["non_graphic_action"]'::jsonb);

-- ── 5. Drop a now-redundant '/modifiers' override ──────────────────────────
-- After stripping, if the override value matches the AI-derived baseline it no
-- longer represents a human divergence — remove the override entry entirely.
UPDATE "facts"
SET "enrichment_overrides" = "enrichment_overrides" - '/modifiers'
WHERE "enrichment_overrides" ? '/modifiers'
  AND "enrichment_ai_derived" IS NOT NULL
  AND ("enrichment_overrides" #> '{/modifiers,value}') = ("enrichment_ai_derived"->'modifiers');

-- ── 6. pending_reviews.enrichment.modifiers ────────────────────────────────
UPDATE "pending_reviews"
SET "enrichment" = jsonb_set("enrichment", '{modifiers}', (
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements("enrichment"->'modifiers') WITH ORDINALITY AS e(value, ord)
  WHERE e.value #>> '{}' NOT IN ('avoid_gore', 'non_graphic_action')
))
WHERE jsonb_typeof("enrichment"->'modifiers') = 'array'
  AND ("enrichment"->'modifiers' @> '["avoid_gore"]'::jsonb
       OR "enrichment"->'modifiers' @> '["non_graphic_action"]'::jsonb);

-- ── 7. Scrub the admin-configurable classifier prompt ──────────────────────
-- The fact-enrichment system prompt is seeded ON CONFLICT DO NOTHING, so an
-- existing row keeps advertising the retired modifiers. Remove ONLY the two
-- catalog lines; preserve any other admin edits and preserve NULL debug_value.
UPDATE "admin_config"
SET "value" = replace(replace("value", E'- avoid_gore\n', ''), E'- non_graphic_action\n', '')
WHERE "key" = 'fact_enrichment_system'
  AND "value" LIKE '%- avoid_gore%';

UPDATE "admin_config"
SET "debug_value" = CASE
    WHEN "debug_value" IS NULL THEN NULL
    ELSE replace(replace("debug_value", E'- avoid_gore\n', ''), E'- non_graphic_action\n', '')
  END
WHERE "key" = 'fact_enrichment_system'
  AND "debug_value" LIKE '%- avoid_gore%';
