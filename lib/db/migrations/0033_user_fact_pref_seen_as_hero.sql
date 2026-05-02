-- Track when a fact was last surfaced as the home page hero for a user, so the
-- weighted-random hero rotator can avoid showing the same fact twice in a row
-- across visits for logged-in users.
ALTER TABLE "user_fact_preferences"
  ADD COLUMN IF NOT EXISTS "last_seen_as_hero_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ufp_user_seen_hero_idx"
  ON "user_fact_preferences" ("user_id", "last_seen_as_hero_at");
