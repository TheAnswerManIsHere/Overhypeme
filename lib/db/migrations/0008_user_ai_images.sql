CREATE TABLE IF NOT EXISTS user_ai_images (
  id serial PRIMARY KEY,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fact_id integer NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  gender varchar(10) NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "IDX_uai_user_id" ON user_ai_images (user_id);
CREATE INDEX IF NOT EXISTS "IDX_uai_fact_id" ON user_ai_images (fact_id);
