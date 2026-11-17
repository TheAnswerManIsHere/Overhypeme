-- Pictures drawn straight from the approved gag, increment 2 (plan
-- docs/plans/PLAN_GAG_DIRECT_RENDER.md, *Proposed Design* E): the fold of the
-- eleven "More art direction" fields into a gag version's scene keeps the
-- original content of every converted version, so the fold can be reversed.
-- Expand only: a new table nothing earlier reads.
--
-- fact_gag_fold_archive: one row per conversion, append-only.
--   gag_id, fact_id: the version's gag and fact. Records, with no foreign key,
--     as comparison_panels.gag_id (migration 0144): a key would tie fact_gags
--     to this table, and migration 0139's reverse script drops fact_gags.
--   stage: "approved" or "pending", the version converted.
--   original_content: the version as it was before the fold.
--   folded_content: what the fold wrote; a reversal restores the original
--     only while the version still holds exactly this.
--   moved: the field names whose text went into the scene.
--   reverted_at: set when a reversal restored the original.
CREATE TABLE IF NOT EXISTS "fact_gag_fold_archive" (
  "id" bigserial PRIMARY KEY,
  "gag_id" bigint NOT NULL,
  "fact_id" integer NOT NULL,
  "stage" varchar(16) NOT NULL,
  "original_content" jsonb NOT NULL,
  "folded_content" jsonb NOT NULL,
  "moved" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reverted_at" timestamp with time zone,
  CONSTRAINT "fact_gag_fold_archive_stage" CHECK (("stage")::text = ANY ((ARRAY['approved'::character varying, 'pending'::character varying])::text[]))
);
CREATE INDEX IF NOT EXISTS "IDX_fact_gag_fold_archive_gag" ON "fact_gag_fold_archive" ("gag_id", "stage");
