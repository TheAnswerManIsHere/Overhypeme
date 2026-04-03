ALTER TABLE upload_image_metadata ADD COLUMN IF NOT EXISTS user_id varchar REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "IDX_uim_user_id" ON upload_image_metadata (user_id);
