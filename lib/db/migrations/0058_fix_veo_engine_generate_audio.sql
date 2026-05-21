-- Fix: remove the `generate_audio` param from the Veo 3.1 Lite and Veo 3.1 Fast
-- engine paramSchemas.
--
-- `generate_audio` is a Seedance (native_audio_boolean) parameter. Veo engines
-- use native_lipsync and do not accept this field — fal.ai returns a 422
-- "no_media_generated" error when it is present in the request body.
--
-- Pure DML — no schema delta.

UPDATE engines
SET param_schema = jsonb_set(
  param_schema,
  '{params}',
  (
    SELECT jsonb_agg(elem ORDER BY ordinality)
    FROM jsonb_array_elements(param_schema->'params') WITH ORDINALITY AS t(elem, ordinality)
    WHERE elem->>'name' != 'generate_audio'
  )
)
WHERE id IN ('veo-3.1-lite', 'veo-3.1-fast');
