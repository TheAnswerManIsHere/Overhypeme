-- The prompt tuner, part 2 (plan docs/plans/PLAN_PROMPT_TUNER.md, *Proposed
-- Design* A and D): versioned prompt recipes per engine family, promotions,
-- and the version each render attempt compiles with. Expand only: no existing
-- row changes, and a family with no promotion compiles with the baseline,
-- today's wording, exactly as before.
--
-- prompt_recipe_versions: one engine family's complete global wording, saved
--   once and never edited (a change saves a new number).
-- prompt_recipe_promotions: the newest row per family is the live version;
--   version_id null restores the baseline.
-- image_prompt_attempts.recipe_version_id: the version an attempt compiles
--   with, chosen when it is queued; null is the baseline.
CREATE TABLE IF NOT EXISTS "prompt_recipe_versions" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "engine_family" varchar(64) NOT NULL,
  "number" integer NOT NULL,
  "pieces" jsonb NOT NULL,
  "note" text NOT NULL,
  "created_by" varchar,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prompt_recipe_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null
);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_prompt_recipe_versions_family_number" ON "prompt_recipe_versions" ("engine_family", "number");

CREATE TABLE IF NOT EXISTS "prompt_recipe_promotions" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "engine_family" varchar(64) NOT NULL,
  "version_id" bigint,
  "promoted_by" varchar,
  "promoted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prompt_recipe_promotions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "prompt_recipe_versions"("id") ON DELETE restrict,
  CONSTRAINT "prompt_recipe_promotions_promoted_by_users_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "users"("id") ON DELETE set null
);
CREATE INDEX IF NOT EXISTS "IDX_prompt_recipe_promotions_family" ON "prompt_recipe_promotions" ("engine_family", "id");

ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "recipe_version_id" bigint;
DO $$ BEGIN
  ALTER TABLE "image_prompt_attempts" ADD CONSTRAINT "image_prompt_attempts_recipe_version_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "prompt_recipe_versions"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
