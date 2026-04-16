import { db } from "@workspace/db";
import { factsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { eq, sql, gt } from "drizzle-orm";
import { SEED_FACTS } from "../data/seed-facts";
import { embedFactAsync } from "./embeddings";

/**
 * Idempotent schema migration that adds any columns which may be missing when
 * the production database is restored into the development environment (or when
 * a fresh DB is used that pre-dates a schema addition).  Uses
 * ADD COLUMN IF NOT EXISTS so it is safe to run on every startup.
 */
export async function ensureSchema(): Promise<void> {
  const migrations: { label: string; ddl: string }[] = [
    {
      label: "facts.has_pronouns",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS has_pronouns boolean NOT NULL DEFAULT false`,
    },
    {
      label: "users.pronouns",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns varchar(20) DEFAULT 'he/him'`,
    },
    {
      label: "users.pronouns widen to varchar(80)",
      ddl: `ALTER TABLE users ALTER COLUMN pronouns TYPE varchar(80)`,
    },
    {
      label: "password_reset_tokens table",
      ddl: `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "password_reset_tokens.IDX_prt_token_hash",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_prt_token_hash" ON password_reset_tokens (token_hash)`,
    },
    {
      label: "facts.is_active",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
    },
    {
      label: "users.is_active",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
    },
    {
      label: "facts.canonical_text",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS canonical_text text`,
    },
    {
      label: "comments.status",
      ddl: `ALTER TABLE comments ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'pending'`,
    },
    {
      label: "comments.status backfill approved",
      ddl: `UPDATE comments SET status = 'approved' WHERE status = 'pending' AND flagged = false AND created_at < now() - interval '1 hour'`,
    },
    {
      label: "users.display_name",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name varchar`,
    },
    {
      label: "users.email_verified_at",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`,
    },
    {
      label: "email_verification_tokens table",
      ddl: `CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "email_verification_tokens.IDX_evt_token_hash",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_evt_token_hash" ON email_verification_tokens (token_hash)`,
    },
    {
      label: "users.pending_email",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email varchar`,
    },
    {
      label: "email_verification_tokens.pending_email",
      ddl: `ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS pending_email varchar`,
    },
    {
      label: "users.drop_username",
      ddl: `ALTER TABLE users DROP COLUMN IF EXISTS username`,
    },
    {
      label: "memes.is_low_res",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS is_low_res boolean NOT NULL DEFAULT false`,
    },
    {
      label: "memes.original_width",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS original_width integer`,
    },
    {
      label: "memes.original_height",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS original_height integer`,
    },
    {
      label: "memes.upload_file_size_bytes",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS upload_file_size_bytes integer`,
    },
    {
      label: "upload_image_metadata table",
      ddl: `CREATE TABLE IF NOT EXISTS upload_image_metadata (
        object_path text PRIMARY KEY,
        width integer NOT NULL,
        height integer NOT NULL,
        is_low_res boolean NOT NULL DEFAULT false,
        file_size_bytes integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "upload_image_metadata.user_id",
      ddl: `ALTER TABLE upload_image_metadata ADD COLUMN IF NOT EXISTS user_id varchar REFERENCES users(id) ON DELETE SET NULL`,
    },
    {
      label: "upload_image_metadata.IDX_uim_user_id",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_uim_user_id" ON upload_image_metadata (user_id)`,
    },
    {
      label: "user_ai_images table",
      ddl: `CREATE TABLE IF NOT EXISTS user_ai_images (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        object_path text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "user_ai_images.IDX_uai_user_id",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_uai_user_id" ON user_ai_images (user_id)`,
    },
    {
      label: "admin_config table",
      ddl: `CREATE TABLE IF NOT EXISTS admin_config (
        key varchar(100) PRIMARY KEY,
        value varchar(500) NOT NULL,
        data_type varchar(20) NOT NULL DEFAULT 'integer',
        label varchar(200) NOT NULL,
        description text,
        min_value integer,
        max_value integer,
        is_public boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by_id varchar REFERENCES users(id) ON DELETE SET NULL
      )`,
    },
    {
      label: "admin_config seed defaults",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
        ('ai_gallery_display_limit', '50', 'integer', 'AI Gallery Display Limit',
         'Maximum number of AI-generated backgrounds shown per gender in the Meme Builder gallery.',
         1, 500, true),
        ('ai_max_images_per_gender', '34', 'integer', 'AI Max Images Per Fact Per Gender',
         'Maximum AI images stored per gender per fact (3 genders × this value ≈ total per-fact cap). Oldest images are evicted when reached.',
         1, 500, false),
        ('user_max_images', '1000', 'integer', 'User Max Image Storage',
         'Total image storage limit per paid user, combining AI-generated images and uploaded photos. Oldest AI images are evicted when limit is reached.',
         10, 10000, false),
        ('pexels_photos_per_gender', '80', 'integer', 'Pexels Photos Per Fact Per Gender',
         'Number of stock photos fetched from Pexels per gender variant when processing a fact. Pexels maximum is 80.',
         1, 80, false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "memes.deleted_at",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
    },
    {
      label: "memes.IDX_memes_deleted_at",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_memes_deleted_at" ON memes (deleted_at) WHERE deleted_at IS NULL`,
    },
    {
      label: "admin_config seed max_memes_per_fact",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
        VALUES ('max_memes_per_fact', '40', 'integer', 'Max Memes Per Fact',
         'Maximum number of memes returned per fact in the gallery (applies to both public and personal views).',
         1, 500, false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "video_job_status enum",
      ddl: `DO $$ BEGIN
        CREATE TYPE video_job_status AS ENUM ('pending', 'completed', 'failed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$`,
    },
    {
      label: "video_jobs table",
      ddl: `CREATE TABLE IF NOT EXISTS video_jobs (
        id serial PRIMARY KEY,
        fact_id integer NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        image_url text NOT NULL,
        video_url text,
        status video_job_status NOT NULL DEFAULT 'pending',
        ip_address varchar(45) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "video_jobs.video_jobs_fact_id_idx",
      ddl: `CREATE INDEX IF NOT EXISTS "video_jobs_fact_id_idx" ON video_jobs (fact_id)`,
    },
    {
      label: "video_jobs.video_jobs_ip_address_idx",
      ddl: `CREATE INDEX IF NOT EXISTS "video_jobs_ip_address_idx" ON video_jobs (ip_address)`,
    },
    {
      label: "video_jobs.video_jobs_created_at_idx",
      ddl: `CREATE INDEX IF NOT EXISTS "video_jobs_created_at_idx" ON video_jobs (created_at)`,
    },
    {
      label: "user_ai_images.add_image_type",
      ddl: `ALTER TABLE user_ai_images ADD COLUMN IF NOT EXISTS image_type varchar(20) NOT NULL DEFAULT 'generic'`,
    },
    {
      label: "admin_config.value type text",
      ddl: `ALTER TABLE admin_config ALTER COLUMN value TYPE text`,
    },
    {
      label: "admin_config.value_label column",
      ddl: `ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS value_label text`,
    },
    {
      label: "admin_config.debug_value_label column",
      ddl: `ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS debug_value_label text`,
    },
    {
      label: "admin_config delete ai_reference_frame_prompt",
      ddl: `DELETE FROM admin_config WHERE key = 'ai_reference_frame_prompt'`,
    },
    {
      label: "admin_config seed style_suffixes",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public) VALUES
        ('style_suffix_cinematic', 'Rendered in a dramatic cinematic style with deep shadows, volumetric lighting, lens flare, and a dark moody color palette with warm orange and amber highlights. Composition resembles a widescreen movie still.', 'text', 'Cinematic — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_cinematic', 'Reimagine this scene in a dramatic cinematic style with deep shadows, volumetric lighting, lens flare, and a dark moody color palette with warm orange and amber highlights. Composition resembles a widescreen movie still.', 'text', 'Cinematic — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_epic', 'Depicted as an epic mythological scene with divine lighting breaking through storm clouds, dramatic scale, and a sense of legendary power. Renaissance composition with baroque intensity.', 'text', 'Epic / Mythological — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_epic', 'Transform this into an epic mythological scene with divine lighting breaking through storm clouds, dramatic scale, and a sense of legendary power. Renaissance composition with baroque intensity.', 'text', 'Epic / Mythological — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_anime', 'Illustrated in detailed Japanese anime style with dynamic action lines, expressive features, vibrant color saturation, and dramatic shading. Bold outlines with cel-shaded rendering.', 'text', 'Anime — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_anime', 'Reimagine this person/scene in detailed Japanese anime style with dynamic action lines, expressive features, vibrant color saturation, and dramatic shading. Bold outlines with cel-shaded rendering.', 'text', 'Anime — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_comic', 'Drawn in bold American comic book style with heavy black ink outlines, dynamic perspective, halftone dot shading, vivid flat colors, and dramatic foreshortening. Speech-bubble-ready composition.', 'text', 'Comic Book — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_comic', 'Transform this into bold American comic book style with heavy black ink outlines, dynamic perspective, halftone dot shading, vivid flat colors, and dramatic foreshortening.', 'text', 'Comic Book — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_cyberpunk', 'Rendered in a cyberpunk aesthetic with neon-soaked lighting in magenta and cyan, rain-slicked reflective surfaces, holographic elements, and a gritty dystopian urban atmosphere.', 'text', 'Cyberpunk — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_cyberpunk', 'Reimagine this scene in a cyberpunk aesthetic with neon-soaked lighting in magenta and cyan, rain-slicked reflective surfaces, holographic elements, and a gritty dystopian urban atmosphere.', 'text', 'Cyberpunk — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_pixel-art', 'Created as detailed 32-bit pixel art with clean sprite work, limited color palette, visible pixel grid, and retro video game aesthetic reminiscent of classic arcade games.', 'text', 'Pixel Art — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_pixel-art', 'Reimagine this as detailed 32-bit pixel art with clean sprite work, limited color palette, visible pixel grid, and retro video game aesthetic reminiscent of classic arcade games.', 'text', 'Pixel Art — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_oil-painting', 'Rendered as a classical oil painting with visible brushstrokes, rich impasto texture, Rembrandt-style chiaroscuro lighting, and the gravitas of a museum masterpiece.', 'text', 'Oil Painting — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_oil-painting', 'Transform this into a classical oil painting with visible brushstrokes, rich impasto texture, Rembrandt-style chiaroscuro lighting, and the gravitas of a museum masterpiece.', 'text', 'Oil Painting — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_propaganda', 'Designed as a bold Soviet-era propaganda poster with limited flat color palette of red, black, cream, and gold. Strong geometric composition, heroic upward angles, and blocky stylized figures.', 'text', 'Propaganda Poster — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_propaganda', 'Reimagine this as a bold Soviet-era propaganda poster with limited flat color palette of red, black, cream, and gold. Strong geometric composition, heroic upward angles, and blocky stylized figures.', 'text', 'Propaganda Poster — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_pop-art', 'Illustrated in Andy Warhol-inspired pop art style with bold primary colors, Ben-Day dots, thick black outlines, flat graphic shapes, and high-contrast repetition.', 'text', 'Pop Art — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_pop-art', 'Transform this into Andy Warhol-inspired pop art style with bold primary colors, Ben-Day dots, thick black outlines, flat graphic shapes, and high-contrast repetition.', 'text', 'Pop Art — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_watercolor', 'Painted in loose expressive watercolor style with soft wet-on-wet color bleeds, visible paper texture, delicate washes, and areas of intentional white space where the paper shows through.', 'text', 'Watercolor — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_watercolor', 'Reimagine this in loose expressive watercolor style with soft wet-on-wet color bleeds, visible paper texture, delicate washes, and areas of intentional white space where the paper shows through.', 'text', 'Watercolor — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_photorealistic', 'Rendered as a hyper-photorealistic image with natural lighting, accurate material textures, shallow depth of field, and the quality of a high-end DSLR photograph.', 'text', 'Photorealistic — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_photorealistic', 'Reimagine this as a hyper-photorealistic image with natural lighting, accurate material textures, shallow depth of field, and the quality of a high-end DSLR photograph.', 'text', 'Photorealistic — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_graffiti', 'Created as vibrant street art on a weathered concrete wall with spray paint drips, stencil layers, bold tagging elements, and a raw urban energy. Mixed media collage feel.', 'text', 'Graffiti / Street Art — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_graffiti', 'Transform this into vibrant street art on a weathered concrete wall with spray paint drips, stencil layers, bold tagging elements, and a raw urban energy. Mixed media collage feel.', 'text', 'Graffiti / Street Art — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_sketch', 'Drawn as a detailed technical pencil sketch on aged parchment with cross-hatching, construction lines, annotated measurements, and the feel of a genius inventor''s notebook.', 'text', 'Sketch / Blueprint — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_sketch', 'Reimagine this as a detailed technical pencil sketch on aged parchment with cross-hatching, construction lines, annotated measurements, and the feel of a genius inventor''s notebook.', 'text', 'Sketch / Blueprint — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_pulp-fiction', 'Illustrated in 1950s pulp fiction magazine cover style with exaggerated dramatic poses, saturated lurid colors, painted texture, and sensational vintage typography framing.', 'text', 'Retro Pulp Fiction — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_pulp-fiction', 'Transform this into a 1950s pulp fiction magazine cover style with exaggerated dramatic poses, saturated lurid colors, painted texture, and sensational vintage typography framing.', 'text', 'Retro Pulp Fiction — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_stained-glass', 'Depicted as an ornate cathedral stained glass window with bold black leading lines, jewel-tone translucent color segments, radiant backlighting, and gothic architectural framing.', 'text', 'Stained Glass — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_stained-glass', 'Reimagine this as an ornate cathedral stained glass window with bold black leading lines, jewel-tone translucent color segments, radiant backlighting, and gothic architectural framing.', 'text', 'Stained Glass — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_claymation', 'Rendered to look like a stop-motion claymation scene with visible fingerprint textures on clay surfaces, slightly imperfect sculpted forms, miniature set design, and soft directional studio lighting.', 'text', 'Claymation — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_claymation', 'Reimagine this as a stop-motion claymation scene with visible fingerprint textures on clay surfaces, slightly imperfect sculpted forms, miniature set design, and soft directional studio lighting.', 'text', 'Claymation — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_ukiyo-e', 'Illustrated in traditional Japanese ukiyo-e woodblock print style with flat color areas, bold flowing outlines, stylized wave and cloud motifs, and a muted natural pigment palette.', 'text', 'Ukiyo-e — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_ukiyo-e', 'Reimagine this in traditional Japanese ukiyo-e woodblock print style with flat color areas, bold flowing outlines, stylized wave and cloud motifs, and a muted natural pigment palette.', 'text', 'Ukiyo-e — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false),
        ('style_suffix_neon-noir', 'Rendered in neon noir style with a rain-drenched nighttime setting, deep black shadows pierced only by harsh neon signage reflections, film grain, and a moody detective-thriller atmosphere.', 'text', 'Neon Noir — Standard Suffix', 'Style suffix appended to the scene prompt for generic AI generation.', false),
        ('style_suffix_ref_neon-noir', 'Reimagine this scene in neon noir style with a rain-drenched nighttime setting, deep black shadows pierced only by harsh neon signage reflections, film grain, and a moody detective-thriller atmosphere.', 'text', 'Neon Noir — Reference Suffix', 'Style suffix appended to the scene prompt when generating from a reference photo.', false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed ai_scene_prompt_model",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('ai_scene_prompt_model', 'gpt-4o-mini', 'text', 'AI Scene Prompt Model',
          'OpenAI chat completion model used when generating cinematic scene descriptions for AI meme backgrounds.',
          false)
        ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed ai_scene_prompt_max_tokens",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('ai_scene_prompt_max_tokens', '400', 'integer', 'AI Scene Prompt Max Tokens',
          'Maximum number of tokens the scene prompt model may generate per request.',
          false)
        ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed ai_scene_prompt_temperature",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('ai_scene_prompt_temperature', '0.7', 'text', 'AI Scene Prompt Temperature',
          'Sampling temperature for the scene prompt model (0.0–2.0). Higher values produce more varied results.',
          false)
        ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed stripe_live_mode",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('stripe_live_mode', 'false', 'boolean', 'Stripe Live Mode',
          'When enabled, Stripe uses live credentials and charges real cards. Disable to use test mode. This is independent from debug mode.',
          false)
        ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "users.membership_tier add legendary",
      ddl: `DO $$ BEGIN
        ALTER TYPE membership_tier ADD VALUE IF NOT EXISTS 'legendary';
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$`,
    },
    {
      label: "admin_config seed ai_scene_prompt_system",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('ai_scene_prompt_system',
          $$You generate cinematic scene prompts for AI image generation for meme backgrounds.

Given a personalized fact template (using tokens like {NAME}, {SUBJ}, {OBJ}, {POSS}), produce three scene prompts for cinematic AI image generation.

Rules:
1. Classify the fact:
   - "action" = a person doing something physical, social, or occupational
   - "abstract" = cosmic, metaphysical, or impossible to photograph
2. For "action" facts: produce 3 different prompts (male, female, neutral subject).
   For "abstract" facts: all 3 prompts can be identical dramatic cinematic scenes.
3. Each prompt must:
   - Describe a SQUARE cinematic scene
   - Have dramatic lighting, high contrast, cinematic quality
   - NOT contain any text or letters
   - Be 20-40 words
   - Start with "Cinematic " or "Epic " or "Dramatic "

Return ONLY valid JSON:
{"fact_type":"action","male":"Cinematic shot of a muscular man...","female":"Cinematic shot of a strong woman...","neutral":"Dramatic scene of a person..."}$$,
          'text', 'AI Scene Prompt (System)',
          'The system prompt sent to gpt-4o-mini when generating cinematic scene descriptions for AI meme backgrounds. Must instruct the model to return JSON with fact_type, male, female, and neutral keys.',
          false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed fal_ai_image_models",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public) VALUES
        ('ai_image_model_standard', 'fal-ai/flux-pro/v1.1', 'text', 'AI Image Model (Standard)',
         'fal.ai model ID used for standard text-to-image generation (no reference photo). Change to swap the generation model without a code deploy.',
         true),
        ('ai_image_model_reference', 'fal-ai/flux-pulid', 'text', 'AI Image Model (Reference Photo)',
         'fal.ai model ID used when generating from a reference photo. Should be a face-preserving model such as flux-pulid (PuLID for FLUX).',
         true),
        ('ai_image_size', 'square_hd', 'text', 'AI Image Size',
         'Image size token passed to fal.ai models (e.g. square_hd, landscape_4_3, portrait_4_3). Must be a size supported by the chosen model.',
         false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config.debug_value column",
      ddl: `ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS debug_value text`,
    },
    {
      label: "admin_config seed debug_mode_active",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('debug_mode_active', 'false', 'boolean', 'Debug Mode Active',
          'When true, all config values fall back to their Debug Value (if set) instead of the Standard Value. Toggle this in the Config panel to switch between production and debug settings.',
          false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed model params",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
        ('ai_std_num_inference_steps', '28', 'integer', 'Standard Model: Inference Steps',
         'Number of denoising steps. Higher = better quality but slower. Default 28 for FLUX Pro/Dev; use 4 for Schnell.',
         1, 100, false),
        ('ai_std_guidance_scale', '3.5', 'text', 'Standard Model: Guidance Scale',
         'CFG scale controlling how closely the model follows the prompt. FLUX default is 3.5.',
         NULL, NULL, false),
        ('ai_std_safety_tolerance', '2', 'text', 'Standard Model: Safety Tolerance',
         'Safety filter level for FLUX Pro models (1 = most strict, 6 = most permissive). Ignored by Dev/Schnell models.',
         NULL, NULL, false),
        ('ai_std_seed', '', 'text', 'Standard Model: Seed',
         'Fixed seed for reproducible output. Leave empty for a random seed on each generation.',
         NULL, NULL, false),
        ('ai_std_output_format', 'jpeg', 'text', 'Standard Model: Output Format',
         'Output image format: jpeg (smaller, faster) or png (lossless, larger).',
         NULL, NULL, false),
        ('ai_std_aspect_ratio', '1:1', 'text', 'Ultra/FLUX2 Model: Aspect Ratio',
         'Aspect ratio for FLUX Pro Ultra and FLUX 2 models (which use aspect_ratio instead of image_size). Common values: 1:1, 16:9, 9:16, 4:3, 3:4.',
         NULL, NULL, false),
        ('ai_std_ultra_raw', 'false', 'text', 'Ultra Model: Raw Mode',
         'When true, FLUX Pro Ultra generates less processed, more natural-looking images.',
         NULL, NULL, false),
        ('ai_ref_pulid_id_scale', '0.70', 'text', 'PuLID: ID Scale',
         'Face fidelity strength for FLUX PuLID. Range 0.0–1.0. Lower = more scene detail, higher = stronger face likeness.',
         NULL, NULL, false),
        ('ai_ref_pulid_guidance_scale', '5.5', 'text', 'PuLID: Guidance Scale',
         'CFG scale for PuLID generation. Higher gives the text prompt more influence over composition without sacrificing face accuracy.',
         NULL, NULL, false),
        ('ai_ref_pulid_num_inference_steps', '30', 'integer', 'PuLID: Inference Steps',
         'Denoising steps for PuLID generation. More steps = higher quality, slower.',
         1, 100, false),
        ('ai_ref_pulid_true_cfg_scale', '', 'text', 'PuLID: True CFG Scale',
         'PuLID-specific true CFG scale parameter. Leave empty to use the model default.',
         NULL, NULL, false),
        ('ai_ref_pulid_start_step', '', 'text', 'PuLID: Start Step',
         'PuLID identity injection start step. Leave empty to use the model default.',
         NULL, NULL, false),
        ('ai_pulid_composition_suffix', 'Full body wide angle shot. Person shown in action within the scene environment. Show the full setting and context. NOT a portrait or close-up.', 'text', 'PuLID: Composition Suffix',
         'Text appended to scene prompts during PuLID reference generation to prevent the model defaulting to a portrait close-up.',
         NULL, NULL, false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed video_prompt_system_prompt",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('video_prompt_system_prompt',
          'You are a video director. Given an image, write a short cinematic motion prompt (1-2 sentences, max 50 words) describing how to animate the scene for a short video clip. Focus on dramatic, visual motion: camera movement, lighting changes, atmosphere. Describe only the visual action and movement. Respond with only the prompt text, nothing else.',
          'text', 'Video Prompt System (OpenAI)',
          'The system prompt sent to OpenAI when analyzing a background image to auto-generate a video motion prompt. Should instruct the model to act as a video director and return a short cinematic motion description.',
          false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed video model params",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public) VALUES
        ('video_model', 'xai/grok-imagine-video/image-to-video', 'text', 'Video Model',
         'AI model used for video generation (fal.ai or xAI Grok Imagine).', false),
        ('video_duration', '5', 'text', 'Video Duration (seconds)',
         'Duration of generated videos in seconds. Grok Imagine supports 1–15 (default 6). Other models may snap to their own valid values.', false),
        ('video_aspect_ratio', '16:9', 'text', 'Video Aspect Ratio',
         'Aspect ratio for generated videos. Grok supports auto/16:9/4:3/3:2/1:1/2:3/3:4/9:16. Other models may restrict to a subset.', false),
        ('video_resolution', '720p', 'text', 'Video Resolution',
         'Output resolution for Grok Imagine videos. Supported values: 720p (default), 480p. Ignored by most other models.', false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "video_jobs.add_is_private",
      ddl: `ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false`,
    },
    {
      label: "video_jobs.add_user_id",
      ddl: `ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS user_id text`,
    },
    {
      label: "video_styles table",
      ddl: `CREATE TABLE IF NOT EXISTS video_styles (
        id varchar(64) PRIMARY KEY,
        label varchar(128) NOT NULL,
        description text NOT NULL DEFAULT '',
        motion_prompt text NOT NULL DEFAULT '',
        gradient_from varchar(32) NOT NULL DEFAULT '#000000',
        gradient_to varchar(32) NOT NULL DEFAULT '#333333',
        preview_gif_path text,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "video_styles seed defaults",
      ddl: `INSERT INTO video_styles (id, label, description, motion_prompt, gradient_from, gradient_to, sort_order) VALUES
        ('cinematic',      'Cinematic',      'Slow dramatic push-in with moody volumetric lighting and epic atmosphere.',              'Slow cinematic camera push-in, dramatic volumetric lighting, deep shadows, epic atmosphere, film-quality motion blur',                                               '#2d1e00', '#8d6e63', 0),
        ('action',         'Action',         'Fast cuts, shaky cam, and high-energy movement bursting with intensity.',                'High-energy action sequence, rapid camera shake, explosive motion, intense dynamic movement, adrenaline-fueled pacing',                                          '#bf360c', '#ff6d00', 1),
        ('breaking-news',  'Breaking News',  'Urgent broadcast feel with bold motion graphics and news-desk energy.',                  'Urgent breaking-news broadcast style, bold sweeping camera pan, dramatic zoom-in on subject, high-stakes journalistic tension',                                   '#7f0000', '#d32f2f', 2),
        ('hype-reel',      'Hype Reel',      'Hyperpump sports-montage energy with strobing light and triumphant movement.',           'Sports highlight hype reel, triumphant slow-motion moment into fast-forward burst, strobing light flares, crowd energy atmosphere',                              '#1a237e', '#00e5ff', 3),
        ('retro-vhs',      'Retro VHS',      'Nostalgic 80s VHS tape aesthetic with glitchy scan lines and warm grain.',               'Retro VHS tape aesthetic, warm film grain, horizontal scan-line glitch, slow wobbly zoom, 1980s nostalgic camcorder motion',                                    '#1a0030', '#e64a19', 4),
        ('dramatic-zoom',  'Dramatic Zoom',  'Extreme slow push-in zoom that builds unbearable tension.',                             'Extreme dramatic slow-zoom into subject, tension-building silence, subtle vibration, ominous creeping camera approach',                                         '#0a0a0a', '#455a64', 5),
        ('anime',          'Anime',          'Dynamic anime-style motion with speed lines, power surges, and expressive impact.',      'Anime-style dynamic motion, speed-line burst, power aura flare, expressive over-the-top impact frame, heroic pose reveal',                                    '#4a0060', '#0288d1', 6),
        ('epic-storm',     'Epic Storm',     'Swirling storm clouds, lightning flashes, and god-like elemental power.',               'Epic storm atmosphere, swirling dark clouds time-lapse, lightning flash illumination, sweeping aerial crane shot, elemental power surge',                       '#0a0e2e', '#1565c0', 7)
      ON CONFLICT (id) DO NOTHING`,
    },
    // ── fal.ai Pricing Cache + Cost Tracking ──────────────────────────────────
    {
      label: "fal_pricing_cache table",
      ddl: `CREATE TABLE IF NOT EXISTS fal_pricing_cache (
        endpoint_id    TEXT PRIMARY KEY,
        unit_price     NUMERIC(12,6) NOT NULL,
        unit           TEXT NOT NULL,
        currency       TEXT NOT NULL DEFAULT 'USD',
        fetched_at     TIMESTAMPTZ NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "user_generation_costs table",
      ddl: `CREATE TABLE IF NOT EXISTS user_generation_costs (
        id                      SERIAL PRIMARY KEY,
        user_id                 TEXT NOT NULL,
        job_type                TEXT NOT NULL,
        endpoint_id             TEXT NOT NULL,
        unit_price_at_creation  NUMERIC(12,6) NOT NULL,
        billing_units           NUMERIC(12,4) NOT NULL,
        computed_cost_usd       NUMERIC(10,4) NOT NULL,
        pricing_fetched_at      TIMESTAMPTZ NOT NULL,
        job_reference_id        TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "user_generation_costs.IDX_user_created",
      ddl: `CREATE INDEX IF NOT EXISTS "user_gen_costs_user_created_idx"
            ON user_generation_costs (user_id, created_at)`,
    },
    // ── Budget / Pricing config keys ──────────────────────────────────────────
    {
      label: "admin_config seed fal_active_endpoints",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('fal_active_endpoints',
                    '["fal-ai/flux-pro/v1.1","xai/grok-imagine-video/image-to-video","fal-ai/flux-pulid","fal-ai/bytedance/seedance/v1.5/pro/text-to-video","bytedance/seedance-2.0/image-to-video"]',
                    'string',
                    'fal.ai Active Endpoint IDs',
                    'JSON array of fal.ai endpoint IDs to cache pricing for at startup and refresh hourly.',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed budget_period",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('budget_period', 'monthly', 'string', 'Budget Reset Period',
                    'How often the per-user generation budget resets. Values: "monthly" (1st of month) or "rolling_30d" (last 30 days).',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed budget_limit_free_usd",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('budget_limit_free_usd', '0.50', 'string', 'Free Tier Generation Budget (USD)',
                    'Maximum fal.ai generation spend per budget period for free-tier users (USD).',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed budget_limit_legend_usd",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('budget_limit_legend_usd', '10.00', 'string', 'Legendary Tier Generation Budget (USD)',
                    'Maximum fal.ai generation spend per budget period for legendary-tier users (USD).',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed email_from_address",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('email_from_address', 'legends@overhype.me', 'string', 'Transactional Email From Address',
                    'The "From" address used on all outgoing transactional emails (verification, password reset, notifications). Must be a domain verified with Resend.',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed email_reply_to",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('email_reply_to', 'overhypeme+support@gmail.com', 'string', 'Transactional Email Reply-To Address',
                    'The "Reply-To" address on all outgoing transactional emails. Users who reply to an automated email will reach this address. Leave blank to use the From address.',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed pricing_refresh_interval_ms",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('pricing_refresh_interval_ms', '3600000', 'integer', 'Pricing Cache Refresh Interval (ms)',
                    'How often to re-fetch fal.ai pricing from the API (milliseconds). Default: 3600000 (1 hour).',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed background picker display limits",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
        ('bg_display_limit_stock', '20', 'integer', 'Background Picker: Stock Photo Limit',
         'Maximum number of stock photos shown in the background image picker when creating a meme. Does not affect how many are fetched or stored.',
         1, 500, true),
        ('bg_display_limit_gradient', '20', 'integer', 'Background Picker: Gradient Limit',
         'Maximum number of gradient backgrounds shown in the background image picker when creating a meme.',
         1, 200, true),
        ('bg_display_limit_ai', '20', 'integer', 'Background Picker: AI Generated Limit',
         'Maximum number of AI-generated backgrounds shown in the background image picker when creating a meme. Does not affect how many are generated or stored.',
         1, 500, true),
        ('bg_display_limit_upload', '20', 'integer', 'Background Picker: Upload Limit',
         'Maximum number of uploaded images shown in the background image picker when creating a meme. Does not affect storage limits.',
         1, 500, true)
      ON CONFLICT (key) DO NOTHING`,
    },
    // ── Feature flags ──────────────────────────────────────────────────────
    {
      label: "feature_flags seed: video_generation",
      ddl: `INSERT INTO feature_flags (key, display_name, description)
            VALUES ('video_generation', 'Video Generation', 'Ability to generate AI-powered videos from meme images')
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "tier_feature_permissions seed: video_generation",
      ddl: `INSERT INTO tier_feature_permissions (tier, feature_key, enabled)
            VALUES
              ('unregistered', 'video_generation', false),
              ('registered',   'video_generation', false),
              ('legendary',    'video_generation', true)
            ON CONFLICT (tier, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
    },
    // ── Stripe hardening migrations ───────────────────────────────────────────
    {
      label: "users.monthly_generation_limit_override_usd",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_generation_limit_override_usd numeric(10,4)`,
    },
    {
      label: "users.membership_tier default registered",
      ddl: `ALTER TABLE users ALTER COLUMN membership_tier SET DEFAULT 'registered'`,
    },
    {
      label: "stripe_processed_events table",
      ddl: `CREATE TABLE IF NOT EXISTS stripe_processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    },
  ];

  for (const { label, ddl } of migrations) {
    try {
      await db.execute(sql.raw(ddl));
    } catch (err) {
      console.warn(`[schema] Could not apply migration "${label}":`, err);
    }
  }
}

function computeWilsonScore(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes;
  if (n === 0) return 0;
  const z = 1.96;
  const pHat = upvotes / n;
  const numerator = pHat + (z * z) / (2 * n) - z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;
  return numerator / denominator;
}

export async function backfillWilsonScores(): Promise<void> {
  const facts = await db
    .select({ id: factsTable.id, upvotes: factsTable.upvotes, downvotes: factsTable.downvotes, wilsonScore: factsTable.wilsonScore })
    .from(factsTable)
    .where(gt(sql`${factsTable.upvotes} + ${factsTable.downvotes}`, 0));

  const toUpdate = facts.filter((f) => f.wilsonScore === 0 && (f.upvotes + f.downvotes) > 0);
  if (!toUpdate.length) return;

  console.log(`[wilson] Backfilling Wilson scores for ${toUpdate.length} facts...`);
  for (const f of toUpdate) {
    const wilsonScore = computeWilsonScore(f.upvotes, f.downvotes);
    await db.update(factsTable).set({ wilsonScore }).where(eq(factsTable.id, f.id));
  }
  console.log("[wilson] Backfill complete.");
}

export async function seedIfEmpty(): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(factsTable);

  if (count > 0) {
    return;
  }

  console.log("[seed] Production database is empty — seeding", SEED_FACTS.length, "facts...");

  for (const item of SEED_FACTS) {
    const [fact] = await db
      .insert(factsTable)
      .values({ text: item.text, isActive: true })
      .returning({ id: factsTable.id });

    for (const tagName of item.hashtags) {
      const existing = await db
        .select({ id: hashtagsTable.id })
        .from(hashtagsTable)
        .where(eq(hashtagsTable.name, tagName))
        .limit(1);

      let tagId: number;
      if (existing.length > 0) {
        tagId = existing[0].id;
      } else {
        const [newTag] = await db
          .insert(hashtagsTable)
          .values({ name: tagName })
          .returning({ id: hashtagsTable.id });
        tagId = newTag.id;
      }

      await db
        .insert(factHashtagsTable)
        .values({ factId: fact.id, hashtagId: tagId })
        .onConflictDoNothing();
    }

    embedFactAsync(fact.id, item.text).catch(() => {});
  }

  console.log("[seed] Done seeding facts.");
}
