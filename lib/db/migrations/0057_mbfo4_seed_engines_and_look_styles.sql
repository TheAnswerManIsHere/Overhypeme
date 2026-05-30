-- MBFO-4: seed the engines and look_styles tables.
--
-- engines:
--   Veo 3.1 Lite (default video), Veo 3.1 Fast, Kling v3 Standard,
--   Seedance 2.0 Fast, Grok Imagine, PuLID (image utility), auto-subtitle (utility).
--   All non-default video engines gated behind the `engine_experiments` feature
--   flag so casual LEGEND users see only the default; power users with the
--   flag enabled get the full engine selector.
--
-- look_styles:
--   19 visual aesthetics mirrored from the legacy server config at
--   artifacts/api-server/src/config/imageStyles.ts. The runtime now reads from
--   this table; the client-side `aiStylePresets.ts` becomes a compile-time
--   fallback for older builds and tests.

-- ────────────────────────────────────────────────────────────────────────────
-- engines
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO "engines" (
  "id", "provider", "endpoint_id", "label", "description", "kind",
  "tier_requirement", "is_default", "is_active", "sort_order",
  "allowed_durations_sec", "default_duration_sec",
  "allowed_resolutions", "default_resolution",
  "allowed_aspect_ratios", "default_aspect_ratio",
  "supported_modes", "default_mode",
  "audio_handling", "param_schema",
  "estimated_cost_usd_per_call", "estimated_cost_usd_per_second",
  "expected_run_ms", "feature_flag_required"
) VALUES
-- Veo 3.1 Lite — default video engine. Workhorse: 720p w/ audio + lipsync at $0.05/s.
(
  'veo-3.1-lite',
  'google',
  'fal-ai/veo3.1/lite/image-to-video',
  'Veo 3.1 Lite',
  'Google DeepMind. 720p with native audio + lipsync. 4-8s clips. Workhorse for video memes.',
  'video',
  'legendary',
  true,   -- isDefault
  true,
  10,
  '[4, 6, 8]'::jsonb, 6,
  '["720p"]'::jsonb, '720p',
  '["16:9", "1:1", "9:16"]'::jsonb, '16:9',
  '[]'::jsonb, NULL,
  'native_lipsync',
  '{
    "params": [
      { "name": "image_url",   "from": "imageUrl",     "type": "string", "required": true },
      { "name": "prompt",      "from": "motionPrompt", "type": "string", "required": true },
      { "name": "duration",    "from": "durationSec",  "type": "int",    "default": 6 },
      { "name": "aspect_ratio","from": "aspectRatio",  "type": "string", "map": { "landscape": "16:9", "square": "1:1", "portrait": "9:16" } },
      { "name": "resolution",  "from": "resolution",   "type": "string", "default": "720p" },
      { "name": "generate_audio", "from": "generateAudio", "type": "boolean", "default": true }
    ]
  }'::jsonb,
  NULL, 0.05,
  18000,
  NULL  -- default engine: always visible to LEGEND users, no flag required
),
-- Veo 3.1 Fast — premium video engine. 720p/1080p at $0.15/s with audio.
(
  'veo-3.1-fast',
  'google',
  'fal-ai/veo3.1/fast/image-to-video',
  'Veo 3.1 Fast',
  'Google DeepMind. 720p or 1080p with native audio + lipsync. Premium output at higher cost.',
  'video',
  'legendary',
  false,
  true,
  20,
  '[4, 6, 8]'::jsonb, 6,
  '["720p", "1080p"]'::jsonb, '720p',
  '["16:9", "1:1", "9:16"]'::jsonb, '16:9',
  '[]'::jsonb, NULL,
  'native_lipsync',
  '{
    "params": [
      { "name": "image_url",   "from": "imageUrl",     "type": "string", "required": true },
      { "name": "prompt",      "from": "motionPrompt", "type": "string", "required": true },
      { "name": "duration",    "from": "durationSec",  "type": "int",    "default": 6 },
      { "name": "aspect_ratio","from": "aspectRatio",  "type": "string", "map": { "landscape": "16:9", "square": "1:1", "portrait": "9:16" } },
      { "name": "resolution",  "from": "resolution",   "type": "string", "default": "720p" },
      { "name": "generate_audio", "from": "generateAudio", "type": "boolean", "default": true }
    ]
  }'::jsonb,
  NULL, 0.15,
  22000,
  'engine_experiments'
),
-- Kling v3 Standard — voice control option. $0.084-0.154/s depending on audio mode.
(
  'kling-v3-standard',
  'kuaishou',
  'fal-ai/kling-video/v3/standard/image-to-video',
  'Kling v3 Standard',
  'Kuaishou. Native audio in English/Chinese, with explicit voice-control toggle for deterministic dialogue.',
  'video',
  'legendary',
  false,
  true,
  30,
  '[3, 5, 8, 10, 15]'::jsonb, 5,
  '["720p", "1080p"]'::jsonb, '720p',
  '["16:9", "1:1", "9:16"]'::jsonb, '16:9',
  '[]'::jsonb, NULL,
  'voice_control',
  '{
    "params": [
      { "name": "image_url",     "from": "imageUrl",     "type": "string", "required": true },
      { "name": "prompt",        "from": "motionPrompt", "type": "string", "required": true },
      { "name": "duration",      "from": "durationSec",  "type": "stringInt", "default": "5" },
      { "name": "aspect_ratio",  "from": "aspectRatio",  "type": "string", "map": { "landscape": "16:9", "square": "1:1", "portrait": "9:16" } },
      { "name": "negative_prompt", "from": "negativePrompt", "type": "string", "default": "blur, distort, low quality" },
      { "name": "voice_text",    "from": "dialogueText", "type": "string" }
    ]
  }'::jsonb,
  NULL, 0.126,
  28000,
  'engine_experiments'
),
-- Seedance 2.0 Fast — long-form / multi-shot option. $0.2419/s at 720p with audio.
(
  'seedance-2.0-fast',
  'bytedance',
  'bytedance/seedance-2.0/fast/image-to-video',
  'Seedance 2.0 Fast',
  'ByteDance. 4-15s durations, multi-shot capability, strong physics. Audio included.',
  'video',
  'legendary',
  false,
  true,
  40,
  '[4, 6, 8, 10, 12, 15]'::jsonb, 6,
  '["720p"]'::jsonb, '720p',
  '["16:9", "1:1", "9:16", "4:3", "3:4"]'::jsonb, '16:9',
  '[]'::jsonb, NULL,
  'native_audio_boolean',
  '{
    "params": [
      { "name": "image_url",   "from": "imageUrl",     "type": "string", "required": true },
      { "name": "prompt",      "from": "motionPrompt", "type": "string", "required": true },
      { "name": "duration",    "from": "durationSec",  "type": "int",    "default": 6 },
      { "name": "aspect_ratio","from": "aspectRatio",  "type": "string", "map": { "landscape": "16:9", "square": "1:1", "portrait": "9:16" } },
      { "name": "resolution",  "from": "resolution",   "type": "string", "default": "720p" },
      { "name": "generate_audio", "from": "generateAudio", "type": "boolean", "default": true },
      { "name": "end_user_id", "from": "endUserId",    "type": "string", "required": true }
    ]
  }'::jsonb,
  NULL, 0.2419,
  35000,
  'engine_experiments'
),
-- Grok Imagine — Normal/Fun/Custom modes. $0.05/s at 480p; voice via prompt cue.
(
  'grok-imagine',
  'xai',
  'xai/grok-imagine-video/image-to-video',
  'Grok Imagine',
  'xAI. Normal / Fun / Custom modes. Voiceover injected via prompt cue.',
  'video',
  'legendary',
  false,
  true,
  50,
  '[4, 6, 8, 10]'::jsonb, 6,
  '["480p", "720p"]'::jsonb, '480p',
  '["16:9", "1:1", "9:16"]'::jsonb, '16:9',
  '["normal", "fun", "custom"]'::jsonb, 'normal',
  'prompt_cue',
  '{
    "params": [
      { "name": "image_url",   "from": "imageUrl",     "type": "string", "required": true },
      { "name": "prompt",      "from": "motionPrompt", "type": "string", "required": true },
      { "name": "duration",    "from": "durationSec",  "type": "int",    "default": 6 },
      { "name": "aspect_ratio","from": "aspectRatio",  "type": "string", "map": { "landscape": "16:9", "square": "1:1", "portrait": "9:16" } },
      { "name": "resolution",  "from": "resolution",   "type": "string", "default": "480p" },
      { "name": "mode",        "from": "mode",         "type": "string", "default": "normal" }
    ]
  }'::jsonb,
  NULL, 0.05,
  18000,
  'engine_experiments'
),
-- PuLID — image stylization utility used by Stage 1 of the video pipeline + image flow.
(
  'pulid-flux',
  'fal',
  'fal-ai/flux-pulid',
  'PuLID (FLUX)',
  'Face-matched stylization. Internal utility, not user-selectable.',
  'image',
  'legendary',
  true,   -- the only seeded image engine; default by default
  true,
  100,
  NULL, NULL,
  NULL, NULL,
  NULL, NULL,
  '[]'::jsonb, NULL,
  'none',
  '{
    "params": [
      { "name": "reference_image_url", "from": "referenceImageUrl", "type": "string", "required": true },
      { "name": "prompt", "from": "imagePrompt", "type": "string", "required": true }
    ]
  }'::jsonb,
  0.03, NULL,
  18000,
  NULL
),
-- auto-subtitle utility — caption burn-in over the generated video.
(
  'fal-auto-subtitle',
  'fal',
  'fal-ai/workflow-utilities/auto-subtitle',
  'Auto-subtitle (utility)',
  'Burns brand-styled captions into a generated MP4. Internal utility, runs after every video.',
  'utility',
  'legendary',
  true,
  true,
  200,
  NULL, NULL,
  NULL, NULL,
  NULL, NULL,
  '[]'::jsonb, NULL,
  'none',
  '{
    "params": [
      { "name": "video_url",         "from": "videoUrl",        "type": "string", "required": true },
      { "name": "font",              "from": "captionFont",     "type": "string", "default": "Anton" },
      { "name": "font_size",         "from": "captionFontSize", "type": "int",    "default": 70 },
      { "name": "font_color",        "from": "captionColor",    "type": "string", "default": "#ffffff" },
      { "name": "highlight_color",   "from": "highlightColor",  "type": "string", "default": "#ff6b35" },
      { "name": "stroke_width",      "from": "strokeWidth",     "type": "int",    "default": 3 },
      { "name": "stroke_color",      "from": "strokeColor",     "type": "string", "default": "#000000" },
      { "name": "position",          "from": "position",        "type": "string", "default": "bottom" },
      { "name": "y_offset",          "from": "yOffset",         "type": "int",    "default": 75 },
      { "name": "words_per_subtitle","from": "wordsPerSubtitle","type": "int",    "default": 1 },
      { "name": "animation",         "from": "animation",       "type": "boolean","default": true }
    ]
  }'::jsonb,
  0.02, NULL,
  8000,
  NULL
)
ON CONFLICT ("id") DO NOTHING;

--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- look_styles (mirrored from artifacts/api-server/src/config/imageStyles.ts)
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO "look_styles" ("id", "label", "description", "prompt_suffix", "prompt_suffix_reference", "sort_order", "is_active") VALUES
('none', 'Default (no style)', 'No style transformation — render naturally.', '', '', 1, true),
('cinematic', 'Cinematic', 'Dramatic widescreen movie still with deep shadows and warm highlights.',
  'Rendered in a dramatic cinematic style with deep shadows, volumetric lighting, lens flare, and a dark moody color palette with warm orange and amber highlights. Composition resembles a widescreen movie still.',
  'Reimagine this scene in a dramatic cinematic style with deep shadows, volumetric lighting, lens flare, and a dark moody color palette with warm orange and amber highlights. Composition resembles a widescreen movie still.',
  2, true),
('epic', 'Epic / Mythological', 'Divine lighting, dramatic scale, baroque intensity.',
  'Depicted as an epic mythological scene with divine lighting breaking through storm clouds, dramatic scale, and a sense of legendary power. Renaissance composition with baroque intensity.',
  'Transform this into an epic mythological scene with divine lighting breaking through storm clouds, dramatic scale, and a sense of legendary power. Renaissance composition with baroque intensity.',
  3, true),
('anime', 'Anime', 'Japanese cel-shaded animation style.',
  'Illustrated in detailed Japanese anime style with dynamic action lines, expressive features, vibrant color saturation, and dramatic shading. Bold outlines with cel-shaded rendering.',
  'Reimagine this person/scene in detailed Japanese anime style with dynamic action lines, expressive features, vibrant color saturation, and dramatic shading. Bold outlines with cel-shaded rendering.',
  4, true),
('comic', 'Comic book', 'Bold American comic book style with halftone shading.',
  'Drawn in bold American comic book style with heavy black ink outlines, dynamic perspective, halftone dot shading, vivid flat colors, and dramatic foreshortening. Speech-bubble-ready composition.',
  'Transform this into bold American comic book style with heavy black ink outlines, dynamic perspective, halftone dot shading, vivid flat colors, and dramatic foreshortening.',
  5, true),
('cyberpunk', 'Cyberpunk', 'Neon-soaked dystopian urban atmosphere.',
  'Rendered in a cyberpunk aesthetic with neon-soaked lighting in magenta and cyan, rain-slicked reflective surfaces, holographic elements, and a gritty dystopian urban atmosphere.',
  'Reimagine this scene in a cyberpunk aesthetic with neon-soaked lighting in magenta and cyan, rain-slicked reflective surfaces, holographic elements, and a gritty dystopian urban atmosphere.',
  6, true),
('pixel-art', 'Pixel art', 'Retro 32-bit pixel art aesthetic.',
  'Created as detailed 32-bit pixel art with clean sprite work, limited color palette, visible pixel grid, and retro video game aesthetic reminiscent of classic arcade games.',
  'Reimagine this as detailed 32-bit pixel art with clean sprite work, limited color palette, visible pixel grid, and retro video game aesthetic reminiscent of classic arcade games.',
  7, true),
('oil-painting', 'Oil painting', 'Classical oil painting with impasto texture.',
  'Rendered as a classical oil painting with visible brushstrokes, rich impasto texture, Rembrandt-style chiaroscuro lighting, and the gravitas of a museum masterpiece.',
  'Transform this into a classical oil painting with visible brushstrokes, rich impasto texture, Rembrandt-style chiaroscuro lighting, and the gravitas of a museum masterpiece.',
  8, true),
('propaganda', 'Propaganda poster', 'Soviet-era propaganda poster aesthetic.',
  'Designed as a bold Soviet-era propaganda poster with limited flat color palette of red, black, cream, and gold. Strong geometric composition, heroic upward angles, and blocky stylized figures.',
  'Reimagine this as a bold Soviet-era propaganda poster with limited flat color palette of red, black, cream, and gold. Strong geometric composition, heroic upward angles, and blocky stylized figures.',
  9, true),
('pop-art', 'Pop art', 'Warhol-style pop art with Ben-Day dots.',
  'Illustrated in Andy Warhol-inspired pop art style with bold primary colors, Ben-Day dots, thick black outlines, flat graphic shapes, and high-contrast repetition.',
  'Transform this into Andy Warhol-inspired pop art style with bold primary colors, Ben-Day dots, thick black outlines, flat graphic shapes, and high-contrast repetition.',
  10, true),
('watercolor', 'Watercolor', 'Loose wet-on-wet watercolor wash.',
  'Painted in loose expressive watercolor style with soft wet-on-wet color bleeds, visible paper texture, delicate washes, and areas of intentional white space where the paper shows through.',
  'Reimagine this in loose expressive watercolor style with soft wet-on-wet color bleeds, visible paper texture, delicate washes, and areas of intentional white space where the paper shows through.',
  11, true),
('photorealistic', 'Photorealistic', 'Hyper-realistic DSLR photograph quality.',
  'Rendered as a hyper-photorealistic image with natural lighting, accurate material textures, shallow depth of field, and the quality of a high-end DSLR photograph.',
  'Reimagine this as a hyper-photorealistic image with natural lighting, accurate material textures, shallow depth of field, and the quality of a high-end DSLR photograph.',
  12, true),
('graffiti', 'Graffiti / Street art', 'Spray paint on weathered concrete.',
  'Created as vibrant street art on a weathered concrete wall with spray paint drips, stencil layers, bold tagging elements, and a raw urban energy. Mixed media collage feel.',
  'Transform this into vibrant street art on a weathered concrete wall with spray paint drips, stencil layers, bold tagging elements, and a raw urban energy. Mixed media collage feel.',
  13, true),
('sketch', 'Sketch / Blueprint', 'Technical pencil sketch on parchment.',
  'Drawn as a detailed technical pencil sketch on aged parchment with cross-hatching, construction lines, annotated measurements, and the feel of a genius inventor''s notebook.',
  'Reimagine this as a detailed technical pencil sketch on aged parchment with cross-hatching, construction lines, annotated measurements, and the feel of a genius inventor''s notebook.',
  14, true),
('pulp-fiction', 'Retro pulp fiction', '1950s pulp magazine cover style.',
  'Illustrated in 1950s pulp fiction magazine cover style with exaggerated dramatic poses, saturated lurid colors, painted texture, and sensational vintage typography framing.',
  'Transform this into a 1950s pulp fiction magazine cover style with exaggerated dramatic poses, saturated lurid colors, painted texture, and sensational vintage typography framing.',
  15, true),
('stained-glass', 'Stained glass', 'Cathedral stained glass with leading.',
  'Depicted as an ornate cathedral stained glass window with bold black leading lines, jewel-tone translucent color segments, radiant backlighting, and gothic architectural framing.',
  'Reimagine this as an ornate cathedral stained glass window with bold black leading lines, jewel-tone translucent color segments, radiant backlighting, and gothic architectural framing.',
  16, true),
('claymation', 'Claymation', 'Stop-motion claymation with fingerprint texture.',
  'Rendered to look like a stop-motion claymation scene with visible fingerprint textures on clay surfaces, slightly imperfect sculpted forms, miniature set design, and soft directional studio lighting.',
  'Reimagine this as a stop-motion claymation scene with visible fingerprint textures on clay surfaces, slightly imperfect sculpted forms, miniature set design, and soft directional studio lighting.',
  17, true),
('ukiyo-e', 'Ukiyo-e (Japanese woodblock)', 'Traditional Japanese woodblock print.',
  'Illustrated in traditional Japanese ukiyo-e woodblock print style with flat color areas, bold flowing outlines, stylized wave and cloud motifs, and a muted natural pigment palette.',
  'Reimagine this in traditional Japanese ukiyo-e woodblock print style with flat color areas, bold flowing outlines, stylized wave and cloud motifs, and a muted natural pigment palette.',
  18, true),
('neon-noir', 'Neon noir', 'Rain-drenched neon-lit detective thriller.',
  'Rendered in neon noir style with a rain-drenched nighttime setting, deep black shadows pierced only by harsh neon signage reflections, film grain, and a moody detective-thriller atmosphere.',
  'Reimagine this scene in neon noir style with a rain-drenched nighttime setting, deep black shadows pierced only by harsh neon signage reflections, film grain, and a moody detective-thriller atmosphere.',
  19, true)
ON CONFLICT ("id") DO NOTHING;

--> statement-breakpoint

-- Register the engine_experiments feature flag (granted manually per user via admin).
INSERT INTO "feature_flags" ("key", "display_name", "description") VALUES
  ('engine_experiments', 'Engine experiments', 'Show non-default video engines in the wizard advanced sheet')
ON CONFLICT ("key") DO NOTHING;
