-- Add Pexels image data to facts (stores LLM-extracted keywords + top photo IDs per gender variant)
ALTER TABLE facts ADD COLUMN IF NOT EXISTS pexels_images jsonb;

-- User image preferences: persists which photo index the user last chose per fact
CREATE TABLE IF NOT EXISTS user_fact_preferences (
  id          serial        PRIMARY KEY,
  user_id     varchar       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fact_id     integer       NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  image_index integer       NOT NULL DEFAULT 0,
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (user_id, fact_id)
);

CREATE INDEX IF NOT EXISTS ufp_user_id_idx ON user_fact_preferences (user_id);
