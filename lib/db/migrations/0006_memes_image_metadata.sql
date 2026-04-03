ALTER TABLE memes ADD COLUMN IF NOT EXISTS is_low_res BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE memes ADD COLUMN IF NOT EXISTS original_width INTEGER;
ALTER TABLE memes ADD COLUMN IF NOT EXISTS original_height INTEGER;
ALTER TABLE memes ADD COLUMN IF NOT EXISTS upload_file_size_bytes INTEGER;

CREATE TABLE IF NOT EXISTS upload_image_metadata (
  object_path text PRIMARY KEY,
  width integer NOT NULL,
  height integer NOT NULL,
  is_low_res boolean NOT NULL DEFAULT false,
  file_size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
