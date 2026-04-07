CREATE TABLE IF NOT EXISTS feature_flags (
  key varchar(100) PRIMARY KEY,
  display_name varchar(200) NOT NULL,
  description varchar(500),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tier_feature_permissions (
  tier varchar(50) NOT NULL,
  feature_key varchar(100) NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (tier, feature_key)
);

INSERT INTO feature_flags (key, display_name, description) VALUES
  ('meme_private_visibility', 'Private Meme Visibility', 'Allows users to create memes that are not visible to the public'),
  ('meme_upload_photo', 'Custom Photo Upload', 'Allows users to upload their own photos as meme backgrounds'),
  ('meme_rate_limit_high', 'High Meme Rate Limit', 'Grants a higher meme generation rate limit (100/hour instead of 10/hour)'),
  ('comment_captcha_bypass', 'CAPTCHA Bypass for Comments', 'Allows users to post comments without completing a CAPTCHA')
ON CONFLICT (key) DO NOTHING;

INSERT INTO tier_feature_permissions (tier, feature_key, enabled) VALUES
  ('unregistered', 'meme_private_visibility', false),
  ('unregistered', 'meme_upload_photo', false),
  ('unregistered', 'meme_rate_limit_high', false),
  ('unregistered', 'comment_captcha_bypass', false),
  ('free', 'meme_private_visibility', false),
  ('free', 'meme_upload_photo', false),
  ('free', 'meme_rate_limit_high', false),
  ('free', 'comment_captcha_bypass', false),
  ('legendary', 'meme_private_visibility', true),
  ('legendary', 'meme_upload_photo', true),
  ('legendary', 'meme_rate_limit_high', true),
  ('legendary', 'comment_captcha_bypass', true)
ON CONFLICT (tier, feature_key) DO NOTHING;
