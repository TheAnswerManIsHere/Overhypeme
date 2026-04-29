-- Ensure photo upload is enabled for registered tier (UI gate was wrong, but make DB explicit)
INSERT INTO "tier_feature_permissions" ("tier", "feature_key", "enabled")
VALUES ('registered', 'meme_upload_photo', true)
ON CONFLICT ("tier", "feature_key") DO UPDATE SET "enabled" = true;--> statement-breakpoint

-- Add missing admin rows for all existing features (admin was never seeded in 0013)
INSERT INTO "tier_feature_permissions" ("tier", "feature_key", "enabled")
SELECT 'admin', key, true FROM "feature_flags"
ON CONFLICT ("tier", "feature_key") DO NOTHING;--> statement-breakpoint

-- Add AI background generation as its own entry in the features grid
INSERT INTO "feature_flags" ("key", "display_name", "description")
VALUES ('meme_ai_background', 'AI Background Generation', 'Allows users to generate AI-created meme backgrounds')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "tier_feature_permissions" ("tier", "feature_key", "enabled") VALUES
  ('unregistered', 'meme_ai_background', false),
  ('registered',   'meme_ai_background', false),
  ('legendary',    'meme_ai_background', true),
  ('admin',        'meme_ai_background', true)
ON CONFLICT ("tier", "feature_key") DO NOTHING;
