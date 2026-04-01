-- Add image_source column to memes table.
-- Stores the background source for photo-based memes (stock or user upload).
-- NULL means the meme was generated from a gradient template (backwards compatible).
ALTER TABLE memes ADD COLUMN IF NOT EXISTS image_source jsonb;
