ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS value_label text;
ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS debug_value_label text;

-- Seed debug_value to match standard value for dropdown rows where debug_value is NULL/empty
-- This makes the "no override" state explicit with the same value as the standard default.
UPDATE admin_config
SET debug_value = value
WHERE key IN (
  'ai_image_size', 'ai_image_model_standard', 'ai_image_model_reference',
  'ai_std_safety_tolerance', 'ai_std_output_format', 'ai_std_aspect_ratio', 'ai_std_ultra_raw'
) AND (debug_value IS NULL OR debug_value = '');

-- Backfill value_label and debug_value_label using the human-friendly label strings
-- that correspond to the SELECT_CONFIGS mappings in the admin UI.
UPDATE admin_config SET
  value_label = CASE value
    WHEN 'square_hd'      THEN 'Square HD (1024×1024)'
    WHEN 'square'         THEN 'Square (512×512)'
    WHEN 'portrait_4_3'   THEN 'Portrait 4:3 (768×1024)'
    WHEN 'portrait_16_9'  THEN 'Portrait 16:9 (576×1024)'
    WHEN 'landscape_4_3'  THEN 'Landscape 4:3 (1024×768)'
    WHEN 'landscape_16_9' THEN 'Landscape 16:9 (1024×576)'
    WHEN '1'    THEN '1 — Most strict'
    WHEN '2'    THEN '2 — Strict (default)'
    WHEN '3'    THEN '3 — Moderate'
    WHEN '4'    THEN '4 — Permissive'
    WHEN '5'    THEN '5 — Very permissive'
    WHEN '6'    THEN '6 — Most permissive'
    WHEN 'jpeg' THEN 'jpeg — smaller, faster (default)'
    WHEN 'png'  THEN 'png — lossless, larger'
    WHEN '1:1'  THEN '1:1 — Square'
    WHEN '4:3'  THEN '4:3 — Landscape standard'
    WHEN '3:4'  THEN '3:4 — Portrait standard'
    WHEN '16:9' THEN '16:9 — Wide'
    WHEN '9:16' THEN '9:16 — Tall'
    WHEN '21:9' THEN '21:9 — Ultrawide'
    WHEN '9:21' THEN '9:21 — Ultra tall'
    WHEN '3:2'  THEN '3:2 — Landscape photo'
    WHEN '2:3'  THEN '2:3 — Portrait photo'
    WHEN 'false' THEN 'false — processed output (default)'
    WHEN 'true'  THEN 'true — natural, less processed'
    ELSE value
  END,
  debug_value_label = CASE debug_value
    WHEN 'square_hd'      THEN 'Square HD (1024×1024)'
    WHEN 'square'         THEN 'Square (512×512)'
    WHEN 'portrait_4_3'   THEN 'Portrait 4:3 (768×1024)'
    WHEN 'portrait_16_9'  THEN 'Portrait 16:9 (576×1024)'
    WHEN 'landscape_4_3'  THEN 'Landscape 4:3 (1024×768)'
    WHEN 'landscape_16_9' THEN 'Landscape 16:9 (1024×576)'
    WHEN '1'    THEN '1 — Most strict'
    WHEN '2'    THEN '2 — Strict (default)'
    WHEN '3'    THEN '3 — Moderate'
    WHEN '4'    THEN '4 — Permissive'
    WHEN '5'    THEN '5 — Very permissive'
    WHEN '6'    THEN '6 — Most permissive'
    WHEN 'jpeg' THEN 'jpeg — smaller, faster (default)'
    WHEN 'png'  THEN 'png — lossless, larger'
    WHEN '1:1'  THEN '1:1 — Square'
    WHEN '4:3'  THEN '4:3 — Landscape standard'
    WHEN '3:4'  THEN '3:4 — Portrait standard'
    WHEN '16:9' THEN '16:9 — Wide'
    WHEN '9:16' THEN '9:16 — Tall'
    WHEN '21:9' THEN '21:9 — Ultrawide'
    WHEN '9:21' THEN '9:21 — Ultra tall'
    WHEN '3:2'  THEN '3:2 — Landscape photo'
    WHEN '2:3'  THEN '2:3 — Portrait photo'
    WHEN 'false' THEN 'false — processed output (default)'
    WHEN 'true'  THEN 'true — natural, less processed'
    ELSE debug_value
  END
WHERE key IN (
  'ai_image_size', 'ai_image_model_standard', 'ai_image_model_reference',
  'ai_std_safety_tolerance', 'ai_std_output_format', 'ai_std_aspect_ratio', 'ai_std_ultra_raw'
);
