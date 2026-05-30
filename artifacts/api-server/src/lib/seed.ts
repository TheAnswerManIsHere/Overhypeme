import { db } from "@workspace/db";
import {
  factsTable,
  hashtagsTable,
  factHashtagsTable,
} from "@workspace/db/schema";
import { eq, sql, gt } from "drizzle-orm";
import { SEED_FACTS } from "../data/seed-facts";
import { embedFactAsync } from "./embeddings";
import { seedScenePromptConfig } from "./scenePromptConfig";
import { seedVideoDirectionConfig } from "./videoDirection";
import { seedFactEnrichmentConfig } from "./factEnrichmentConfig";
import { seedFactVisualPreviewConfig } from "./factVisualPreviewConfig";
import { seedImagePromptConfig } from "./imagePromptConfig";
import { seedReferenceResearchConfig } from "./referenceResearchConfig";
import { logger } from "./logger";

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
      label: "admin_config seed debug_mode_active",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES ('debug_mode_active', 'false', 'boolean', 'Debug Mode Active',
         'Global staging toggle: when ON, any config key that has a debug value uses it instead of the production value. Used to experiment with settings (e.g. scene-prompt levers) before promoting them. Affects all traffic while ON.',
         false)
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
    // Retired in migration 0060_retire_legacy_model_config_keys:
    //   ai_scene_prompt_model, ai_scene_prompt_max_tokens, ai_scene_prompt_temperature
    // (consumers now use baked-in defaults; engines table is authoritative).
    // Retired in migration 0061_retire_style_suffix_admin_config_keys:
    //   style_suffix_* / style_suffix_ref_* — prompt content now lives on
    //   the look_styles DB table (seeded by migration 0057).
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
    // Retired in migration 0059_retire_legacy_model_config_keys:
    //   ai_scene_prompt_system, ai_image_model_standard, ai_image_model_reference,
    //   ai_image_size (consumers now use baked-in defaults; PuLID/face-reference
    //   path now reads from the engines table via loadDefaultEngine("image")).
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
    // Retired in migration 0059_retire_legacy_model_config_keys:
    //   ai_std_*, ai_ref_pulid_*, ai_pulid_composition_suffix,
    //   video_prompt_system_prompt, video_model, video_duration,
    //   video_aspect_ratio, video_resolution. Image pipeline now uses
    //   baked-in defaults; video flow uses the engines table.
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
      label: "admin_config seed budget_limit_registered_usd",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('budget_limit_registered_usd', '0.50', 'string', 'Registered Tier Generation Budget (USD)',
                    'Maximum fal.ai generation spend per budget period for users on the Registered Tier (USD).',
                    false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed budget_limit_legendary_usd",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public)
            VALUES ('budget_limit_legendary_usd', '10.00', 'string', 'Legendary Tier Generation Budget (USD)',
                    'Maximum fal.ai generation spend per budget period for users on the Legendary Tier (USD).',
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
      label: "admin_config seed email_max_attempts",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
            VALUES ('email_max_attempts', '5', 'integer', 'Email Delivery Max Attempts',
                    'Maximum number of delivery attempts before an outbox email is permanently abandoned. Includes the first attempt. Range: 1–20.',
                    1, 20, false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed email_retry_delay_1_ms",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, is_public)
            VALUES ('email_retry_delay_1_ms', '300000', 'integer', 'Email Retry Delay — Attempt 2 (ms)',
                    'Milliseconds to wait before the 2nd delivery attempt after the 1st failure. Default: 300000 (5 minutes).',
                    0, false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed email_retry_delay_2_ms",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, is_public)
            VALUES ('email_retry_delay_2_ms', '1800000', 'integer', 'Email Retry Delay — Attempt 3 (ms)',
                    'Milliseconds to wait before the 3rd delivery attempt. Default: 1800000 (30 minutes).',
                    0, false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed email_retry_delay_3_ms",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, is_public)
            VALUES ('email_retry_delay_3_ms', '7200000', 'integer', 'Email Retry Delay — Attempt 4 (ms)',
                    'Milliseconds to wait before the 4th delivery attempt. Default: 7200000 (2 hours).',
                    0, false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed email_retry_delay_4_ms",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, is_public)
            VALUES ('email_retry_delay_4_ms', '28800000', 'integer', 'Email Retry Delay — Attempt 5 (ms)',
                    'Milliseconds to wait before the 5th delivery attempt. Default: 28800000 (8 hours).',
                    0, false)
            ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "admin_config seed zazzle params",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, is_public) VALUES
        ('zazzle_at', '238499514566968751', 'string', 'Zazzle Associate ID (at)',
         'The associate/store ID used in the at-{id} portion of the Zazzle Create-a-Product URL.', false),
        ('zazzle_rf', '238499514566968751', 'string', 'Zazzle Referral ID (rf)',
         'Referral tracking parameter — typically the same as the associate ID.', false),
        ('zazzle_ax', 'DesignBlast', 'string', 'Zazzle API Request Type (ax)',
         'Type of API request. Can be linkover or DesignBlast.', false),
        ('zazzle_sr', '250021327078498612', 'string', 'Zazzle Store ID (sr)',
         'The Zazzle store ID where templates are hosted.', false),
        ('zazzle_cg', '196101421498498498', 'string', 'Zazzle Category ID (cg)',
         'The store category ID containing the product templates.', false),
        ('zazzle_ed', 'true', 'string', 'Zazzle Allow Editing (ed)',
         'Whether to allow the customer to edit the product on Zazzle before purchasing (true/false).', false),
        ('zazzle_tc', '', 'string', 'Zazzle Tracking Cookie (tc)',
         'Optional tracking cookie value passed to Zazzle. Leave empty if not used.', false)
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
      label: "admin_config seed review_duplicate_threshold",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
            VALUES ('review_duplicate_threshold', '80', 'integer', 'Duplicate Flag Threshold (%)',
                    'Minimum similarity percentage at which a submission is flagged as a duplicate in the moderation panel. Submissions below this threshold will not show duplicate information. Default: 80.',
                    0, 100, true)
            ON CONFLICT (key) DO UPDATE SET is_public = true`,
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
              ('legendary',    'video_generation', true),
              ('admin',        'video_generation', true)
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
    {
      label: "lifetime_entitlements.status",
      ddl: `ALTER TABLE lifetime_entitlements ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'active'`,
    },
    {
      label: "membership_history.stripe_dispute_id",
      ddl: `ALTER TABLE membership_history ADD COLUMN IF NOT EXISTS stripe_dispute_id varchar`,
    },
    {
      label: "admin_config seed email_outbox_retention_days",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
        VALUES ('email_outbox_retention_days', '30', 'integer', 'Email Outbox Retention (days)',
          'Number of days to keep delivered and abandoned emails in the outbox before they are automatically purged. Set to 0 to disable auto-purge.',
          0, 3650, false)
        ON CONFLICT (key) DO NOTHING`,
    },
    {
      // Dead control: the AI background picker reads ai_gallery_display_limit,
      // never bg_display_limit_ai. Nothing consumed this key, so drop it.
      label: "admin_config delete bg_display_limit_ai",
      ddl: `DELETE FROM admin_config WHERE key = 'bg_display_limit_ai'`,
    },
    {
      // Retired: the PuLID composition/framing suffix is no longer appended to
      // reference-image prompts (moving to Nano Banana). Drop the stale key.
      label: "admin_config delete scene_prompt_composition_suffix",
      ddl: `DELETE FROM admin_config WHERE key = 'scene_prompt_composition_suffix'`,
    },
    {
      label: "facts.enrichment",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS enrichment jsonb`,
    },
    {
      label: "facts.primary_archetype",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS primary_archetype varchar(64)`,
    },
    {
      label: "facts.subtype",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS subtype varchar(64)`,
    },
    {
      label: "facts.overhype_fit",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS overhype_fit varchar(16)`,
    },
    {
      label: "facts.adult_suitability",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS adult_suitability varchar(24)`,
    },
    {
      label: "facts.primary_archetype index",
      ddl: `CREATE INDEX IF NOT EXISTS facts_primary_archetype_idx ON facts (primary_archetype)`,
    },
    {
      label: "facts.adult_suitability index",
      ddl: `CREATE INDEX IF NOT EXISTS facts_adult_suitability_idx ON facts (adult_suitability)`,
    },
    {
      label: "pending_reviews.enrichment",
      ddl: `ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS enrichment jsonb`,
    },
    {
      label: "pending_reviews.enrichment_status",
      ddl: `ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS enrichment_status varchar(16)`,
    },
    {
      label: "engines.default_temperature",
      ddl: `ALTER TABLE engines ADD COLUMN IF NOT EXISTS default_temperature numeric(4,2)`,
    },
    {
      label: "engines.default_max_tokens",
      ddl: `ALTER TABLE engines ADD COLUMN IF NOT EXISTS default_max_tokens integer`,
    },
    {
      label: "engines.default_reasoning_effort",
      ddl: `ALTER TABLE engines ADD COLUMN IF NOT EXISTS default_reasoning_effort varchar(16)`,
    },
    {
      // Consolidated: the model + sampling + reasoning effort for ALL LLM calls
      // now come from the shared General Intelligence engine (engines table,
      // provider "openai"). Only the editable system prompts remain in
      // admin_config. Drop the per-feature model/temperature/max-token/
      // reasoning-effort keys for image style, video motion, and fact enrichment.
      label: "admin_config delete consolidated LLM model/sampling keys",
      ddl: `DELETE FROM admin_config WHERE key IN (
        'scene_prompt_model', 'scene_prompt_temperature', 'scene_prompt_max_tokens', 'scene_prompt_reasoning_effort',
        'video_direction_model', 'video_direction_temperature', 'video_direction_max_tokens', 'video_direction_reasoning_effort',
        'fact_enrichment_model', 'fact_enrichment_temperature', 'fact_enrichment_max_tokens', 'fact_enrichment_reasoning_effort'
      )`,
    },
  ];

  for (const { label, ddl } of migrations) {
    try {
      await db.execute(sql.raw(ddl));
    } catch (err) {
      logger.warn({ err, label }, "[schema] Could not apply migration");
    }
  }

  // Seed the admin-configurable scene-prompt levers (system prompt, OpenAI
  // model, temperature, max tokens) with their production defaults. Idempotent
  // — existing rows / admin edits are preserved.
  await seedScenePromptConfig();

  // Seed the admin-configurable video-direction levers (the motion/action
  // direction layered on top of the motion preset for image-to-video).
  await seedVideoDirectionConfig();

  // Seed the admin-configurable fact-enrichment levers (the visual-taxonomy
  // classifier system prompt, OpenAI model, temperature, max tokens).
  await seedFactEnrichmentConfig();

  // Seed the admin-configurable visual-preview system prompt (Phase 2A —
  // produces the admin-visible visual interpretation preview from the
  // classified taxonomy + cultural references + authored strategy entry).
  await seedFactVisualPreviewConfig();

  // Seed the Phase 2 image-prompt admin config (image-prompt + source-classifier
  // system prompts, active classifier engine id, enable_image_prompt_v2 flag).
  await seedImagePromptConfig();

  // Seed the admin Reference Research tool's system prompt.
  await seedReferenceResearchConfig();
}

function computeWilsonScore(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes;
  if (n === 0) return 0;
  const z = 1.96;
  const pHat = upvotes / n;
  const numerator =
    pHat +
    (z * z) / (2 * n) -
    z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;
  return numerator / denominator;
}

export async function backfillWilsonScores(): Promise<void> {
  const facts = await db
    .select({
      id: factsTable.id,
      upvotes: factsTable.upvotes,
      downvotes: factsTable.downvotes,
      wilsonScore: factsTable.wilsonScore,
    })
    .from(factsTable)
    .where(gt(sql`${factsTable.upvotes} + ${factsTable.downvotes}`, 0));

  const toUpdate = facts.filter(
    (f) => f.wilsonScore === 0 && f.upvotes + f.downvotes > 0,
  );
  if (!toUpdate.length) return;

  logger.info({ count: toUpdate.length }, "[wilson] Backfilling Wilson scores");
  for (const f of toUpdate) {
    const wilsonScore = computeWilsonScore(f.upvotes, f.downvotes);
    await db
      .update(factsTable)
      .set({ wilsonScore })
      .where(eq(factsTable.id, f.id));
  }
  logger.info("[wilson] Backfill complete.");
}

export async function seedIfEmpty(): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(factsTable);

  if (count > 0) {
    return;
  }

  logger.info({ count: SEED_FACTS.length }, "[seed] Production database is empty — seeding facts");

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

  logger.info("[seed] Done seeding facts.");
}
