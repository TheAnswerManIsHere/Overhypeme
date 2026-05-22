-- Phase 6 (MBFO-4 follow-up): retire the legacy ad-hoc per-model admin_config keys.
--
-- Before the engines table was authoritative for fal call shapes, ~30 ad-hoc
-- keys in admin_config controlled image and video generation parameters
-- (model id, image_size, inference steps, PuLID-specific tuning, video model
-- selection, etc.). The wizard video flow now reads from the `engines` table
-- exclusively (see lib/engines/* + engineInterpreter.ts), and the remaining
-- consumers in the AI meme pipeline now use baked-in defaults.
--
-- This migration deletes the obsolete rows so admins can no longer mutate
-- values that the runtime never reads.
--
-- Pure DML — no schema delta. Listed in SNAPSHOT_EXEMPT_TAGS in
-- lib/db/scripts/check-migration-snapshots.ts.

DELETE FROM admin_config WHERE key IN (
  -- Image generation
  'ai_image_model_standard',
  'ai_image_model_reference',
  'ai_image_size',
  'ai_std_num_inference_steps',
  'ai_std_guidance_scale',
  'ai_std_safety_tolerance',
  'ai_std_seed',
  'ai_std_output_format',
  'ai_std_aspect_ratio',
  'ai_std_ultra_raw',
  'ai_ref_pulid_id_scale',
  'ai_ref_pulid_guidance_scale',
  'ai_ref_pulid_num_inference_steps',
  'ai_ref_pulid_true_cfg_scale',
  'ai_ref_pulid_start_step',
  'ai_pulid_composition_suffix',
  'ai_pulid_id_scale_pct',
  'ai_scene_prompt_model',
  'ai_scene_prompt_max_tokens',
  'ai_scene_prompt_temperature',
  'ai_scene_prompt_system',
  -- Video generation
  'video_model',
  'video_duration',
  'video_aspect_ratio',
  'video_resolution',
  'video_prompt_system_prompt'
);
