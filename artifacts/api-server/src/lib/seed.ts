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
      label: "admin_config seed upload_gallery_display_limit",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
        VALUES ('upload_gallery_display_limit', '50', 'integer', 'Upload Gallery Display Limit',
         'Maximum number of uploaded images shown in the Meme Builder reference photo picker. Does not affect storage — users can still upload up to their storage limit.',
         1, 500, true)
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
      label: "admin_config seed ai_reference_frame_prompt",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('ai_reference_frame_prompt',
          'Generate an image using the provided reference photo. The person''s face, facial structure, skin tone, eye shape, hair, and all distinguishing features must be preserved with photorealistic accuracy and remain visually identical to the reference — this is the highest priority. Do not alter, stylize, or idealize the person''s facial features in any way. The person should be placed into the scene as described. The scene and environment should be stylized as described, but the person''s face and likeness must remain untouched by any stylization. No text, words, or letters anywhere in the image.',
          'text', 'AI Reference Frame Prompt',
          'The instruction appended to AI image prompts when a user uploads a reference photo. Controls how strongly the model preserves the subject''s likeness.',
          false)
      ON CONFLICT (key) DO NOTHING`,
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
         false),
        ('ai_image_model_reference', 'fal-ai/ip-adapter-face-id-plus', 'text', 'AI Image Model (Reference Photo)',
         'fal.ai model ID used when generating from a reference photo. Should be a face-preserving model such as ip-adapter-face-id-plus.',
         false),
        ('ai_image_size', 'square_hd', 'text', 'AI Image Size',
         'Image size token passed to fal.ai models (e.g. square_hd, landscape_4_3, portrait_4_3). Must be a size supported by the chosen model.',
         false)
      ON CONFLICT (key) DO NOTHING`,
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
