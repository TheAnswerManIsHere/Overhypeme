-- Polymorphic reactions table backing all up/down/heart tracking across the
-- product (facts, memes, comments). Replaces direct writes to the legacy
-- `ratings` table for fact thumbs and is the sole home for new meme/comment
-- heart reactions. The legacy `ratings` table is preserved (read-only) for
-- backfill verification before any future cleanup.
CREATE TABLE IF NOT EXISTS "reactions" (
  "id" serial PRIMARY KEY,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "target_type" varchar(16) NOT NULL,
  "target_id" integer NOT NULL,
  "reaction_type" varchar(16) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_reactions_user_target_type"
  ON "reactions" ("user_id", "target_type", "target_id", "reaction_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_reactions_target"
  ON "reactions" ("target_type", "target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_reactions_user"
  ON "reactions" ("user_id");
--> statement-breakpoint
-- Backfill existing fact thumbs into the new polymorphic table. Only "up" and
-- "down" rows are imported; "none" rows in the legacy table represent
-- explicit clears and have no semantic meaning in the new model.
INSERT INTO "reactions" ("user_id", "target_type", "target_id", "reaction_type", "created_at")
SELECT "user_id", 'fact', "fact_id", "rating", "created_at"
  FROM "ratings"
  WHERE "rating" IN ('up', 'down')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Precomputed heart counts on memes. Reactions write path keeps these fresh.
ALTER TABLE "memes"
  ADD COLUMN IF NOT EXISTS "heart_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_memes_heart_count"
  ON "memes" ("heart_count");
--> statement-breakpoint
-- Precomputed heart counts on comments. Reactions write path keeps these fresh.
ALTER TABLE "comments"
  ADD COLUMN IF NOT EXISTS "heart_count" integer NOT NULL DEFAULT 0;
