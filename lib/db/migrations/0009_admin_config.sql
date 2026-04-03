CREATE TABLE IF NOT EXISTS admin_config (
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
);

INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
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
ON CONFLICT (key) DO NOTHING;
