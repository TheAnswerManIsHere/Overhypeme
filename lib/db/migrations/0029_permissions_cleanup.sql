-- Permissions and tier nomenclature cleanup.
--
-- Canonical model:
--   • membership_tier ∈ { 'unregistered', 'registered', 'legendary' }
--   • is_admin is an orthogonal boolean flag, NOT a tier
--   • "Lifetime Legendary" is a billing artifact (lifetime_entitlements row),
--     not a separate tier — those users still have membership_tier='legendary'
--   • There is no 'free' tier
--
-- This migration:
--   1. Removes stale tier='free' rows from tier_feature_permissions
--   2. Backfills any missing (tier, feature_key) combinations so every
--      feature has rows for the four valid tier identifiers:
--      unregistered, registered, legendary, admin.
--   3. Renames admin_config keys: budget_limit_free_usd → budget_limit_registered_usd
--      and budget_limit_legend_usd → budget_limit_legendary_usd, and updates
--      their labels/descriptions to reference "Registered Tier" / "Legendary Tier".
--
-- Idempotent: re-running on an already-clean DB is a no-op.

-- ── 1. Drop stale 'free' tier rows ────────────────────────────────────────
DELETE FROM "tier_feature_permissions" WHERE "tier" = 'free';--> statement-breakpoint

-- ── 2. Backfill missing rows so every feature has all 4 tiers ─────────────
-- Defaults: enabled=false for unregistered/registered/legendary, enabled=true for admin.
INSERT INTO "tier_feature_permissions" ("tier", "feature_key", "enabled")
SELECT 'unregistered', key, false FROM "feature_flags"
ON CONFLICT ("tier", "feature_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "tier_feature_permissions" ("tier", "feature_key", "enabled")
SELECT 'registered', key, false FROM "feature_flags"
ON CONFLICT ("tier", "feature_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "tier_feature_permissions" ("tier", "feature_key", "enabled")
SELECT 'legendary', key, false FROM "feature_flags"
ON CONFLICT ("tier", "feature_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "tier_feature_permissions" ("tier", "feature_key", "enabled")
SELECT 'admin', key, true FROM "feature_flags"
ON CONFLICT ("tier", "feature_key") DO NOTHING;--> statement-breakpoint

-- ── 3. Rename admin_config budget keys ────────────────────────────────────
-- budget_limit_free_usd → budget_limit_registered_usd
-- Copy value from the old key if present; otherwise seed default 0.50.
INSERT INTO "admin_config" ("key", "value", "data_type", "label", "description", "min_value", "max_value", "is_public")
SELECT
  'budget_limit_registered_usd',
  COALESCE((SELECT value FROM admin_config WHERE key = 'budget_limit_free_usd'), '0.50'),
  COALESCE((SELECT data_type FROM admin_config WHERE key = 'budget_limit_free_usd'), 'float'),
  'Registered Tier Generation Budget (USD)',
  'Maximum fal.ai generation spend per budget period for users on the Registered Tier (USD).',
  COALESCE((SELECT min_value FROM admin_config WHERE key = 'budget_limit_free_usd'), 0),
  COALESCE((SELECT max_value FROM admin_config WHERE key = 'budget_limit_free_usd'), 10000),
  COALESCE((SELECT is_public FROM admin_config WHERE key = 'budget_limit_free_usd'), false)
ON CONFLICT ("key") DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description;--> statement-breakpoint

-- budget_limit_legend_usd → budget_limit_legendary_usd
INSERT INTO "admin_config" ("key", "value", "data_type", "label", "description", "min_value", "max_value", "is_public")
SELECT
  'budget_limit_legendary_usd',
  COALESCE((SELECT value FROM admin_config WHERE key = 'budget_limit_legend_usd'), '10.00'),
  COALESCE((SELECT data_type FROM admin_config WHERE key = 'budget_limit_legend_usd'), 'float'),
  'Legendary Tier Generation Budget (USD)',
  'Maximum fal.ai generation spend per budget period for users on the Legendary Tier (USD). Applies globally unless a per-user override is set.',
  COALESCE((SELECT min_value FROM admin_config WHERE key = 'budget_limit_legend_usd'), 0),
  COALESCE((SELECT max_value FROM admin_config WHERE key = 'budget_limit_legend_usd'), 10000),
  COALESCE((SELECT is_public FROM admin_config WHERE key = 'budget_limit_legend_usd'), false)
ON CONFLICT ("key") DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description;--> statement-breakpoint

-- Drop the old keys now that the new ones are in place.
DELETE FROM "admin_config" WHERE "key" IN ('budget_limit_free_usd', 'budget_limit_legend_usd');
