-- Launch Phase 3, increment 2 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
-- §1, approved by David 2026-10-27).
--
-- Restores thirteen objects that migrations created and no migration ever
-- dropped, but that the long-lived databases no longer have. Building the
-- baseline found them (#770, 2026-10-27): each is in its migration's SQL and
-- absent from both dev's real catalog and a CI-built one. The schema declares
-- none of the checks or foreign keys, and `drizzle-kit push` removes what the
-- schema does not declare, so every push since they were added stripped them
-- while the ledger kept saying their migrations had run. Phase 3 retires push;
-- this puts back what it took. The definitions are the migrations' named beside
-- each one; the three CHECKs are written in the form PostgreSQL itself prints
-- them (the same rule as `x IN (...)`), so a database restored from a dump and
-- one repaired here store the identical expression.
--
-- NO ROW IS CHANGED, here or anywhere. Two of the checks guard child-safety
-- records (ncmec_reports, quarantined_memes) and only constrain future writes:
--   * a CHECK or FOREIGN KEY that existing rows already satisfy is added
--     normally; one that some existing row breaks is added NOT VALID — it holds
--     for every write from now on, and the NOTICE names the count of rows that
--     break it, so they can be looked at rather than silently rewritten;
--   * the unique index (one profile photo per user) is created only when no
--     user already has two; otherwise it is skipped with a NOTICE, since a
--     unique index cannot be added over duplicates without deleting one.
-- Every step checks for the object first, so a database that has it — one
-- built from the baseline, or this migration re-run — is untouched.

DO $$
DECLARE
  bad bigint;
BEGIN
  -- 0043_moderation_infrastructure
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memes_status_check' AND conrelid = 'memes'::regclass) THEN
    SELECT count(*) INTO bad FROM memes WHERE NOT ("status" IN ('live','quarantined','rejected'));
    IF bad = 0 THEN
      ALTER TABLE "memes" ADD CONSTRAINT "memes_status_check" CHECK (((status)::text = ANY (ARRAY[('live'::character varying)::text, ('quarantined'::character varying)::text, ('rejected'::character varying)::text])));
    ELSE
      ALTER TABLE "memes" ADD CONSTRAINT "memes_status_check" CHECK (((status)::text = ANY (ARRAY[('live'::character varying)::text, ('quarantined'::character varying)::text, ('rejected'::character varying)::text]))) NOT VALID;
    END IF;
    RAISE NOTICE '[0112] memes_status_check restored (existing rows breaking it: %)', bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quarantined_memes_source_check' AND conrelid = 'quarantined_memes'::regclass) THEN
    SELECT count(*) INTO bad FROM quarantined_memes WHERE NOT ("source" IN ('arachnid','fal_safety','classifier','manual'));
    IF bad = 0 THEN
      ALTER TABLE "quarantined_memes" ADD CONSTRAINT "quarantined_memes_source_check" CHECK (((source)::text = ANY (ARRAY[('arachnid'::character varying)::text, ('fal_safety'::character varying)::text, ('classifier'::character varying)::text, ('manual'::character varying)::text])));
    ELSE
      ALTER TABLE "quarantined_memes" ADD CONSTRAINT "quarantined_memes_source_check" CHECK (((source)::text = ANY (ARRAY[('arachnid'::character varying)::text, ('fal_safety'::character varying)::text, ('classifier'::character varying)::text, ('manual'::character varying)::text]))) NOT VALID;
    END IF;
    RAISE NOTICE '[0112] quarantined_memes_source_check restored (existing rows breaking it: %)', bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ncmec_reports_match_source_check' AND conrelid = 'ncmec_reports'::regclass) THEN
    SELECT count(*) INTO bad FROM ncmec_reports WHERE NOT ("match_source" IN ('arachnid','classifier'));
    IF bad = 0 THEN
      ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_match_source_check" CHECK (((match_source)::text = ANY (ARRAY[('arachnid'::character varying)::text, ('classifier'::character varying)::text])));
    ELSE
      ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_match_source_check" CHECK (((match_source)::text = ANY (ARRAY[('arachnid'::character varying)::text, ('classifier'::character varying)::text]))) NOT VALID;
    END IF;
    RAISE NOTICE '[0112] ncmec_reports_match_source_check restored (existing rows breaking it: %)', bad;
  END IF;

  -- 0076_moderation_render_scenarios
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'image_prompt_attempts_review_id_fk' AND conrelid = 'image_prompt_attempts'::regclass) THEN
    SELECT count(*) INTO bad FROM image_prompt_attempts a
      WHERE a.review_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pending_reviews r WHERE r.id = a.review_id);
    IF bad = 0 THEN
      ALTER TABLE "image_prompt_attempts" ADD CONSTRAINT "image_prompt_attempts_review_id_fk"
        FOREIGN KEY ("review_id") REFERENCES "pending_reviews"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    ELSE
      ALTER TABLE "image_prompt_attempts" ADD CONSTRAINT "image_prompt_attempts_review_id_fk"
        FOREIGN KEY ("review_id") REFERENCES "pending_reviews"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
    END IF;
    RAISE NOTICE '[0112] image_prompt_attempts_review_id_fk restored (existing rows breaking it: %)', bad;
  END IF;

  -- 0048_meme_builder_lineage
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uim_source_object_path_fk' AND conrelid = 'upload_image_metadata'::regclass) THEN
    SELECT count(*) INTO bad FROM upload_image_metadata u
      WHERE u.source_object_path IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM upload_image_metadata s WHERE s.object_path = u.source_object_path);
    IF bad = 0 THEN
      ALTER TABLE "upload_image_metadata" ADD CONSTRAINT "uim_source_object_path_fk"
        FOREIGN KEY ("source_object_path") REFERENCES "upload_image_metadata"("object_path") ON DELETE SET NULL ON UPDATE NO ACTION;
    ELSE
      ALTER TABLE "upload_image_metadata" ADD CONSTRAINT "uim_source_object_path_fk"
        FOREIGN KEY ("source_object_path") REFERENCES "upload_image_metadata"("object_path") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
    END IF;
    RAISE NOTICE '[0112] uim_source_object_path_fk restored (existing rows breaking it: %)', bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uim_fact_id_fk' AND conrelid = 'upload_image_metadata'::regclass) THEN
    SELECT count(*) INTO bad FROM upload_image_metadata u
      WHERE u.fact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = u.fact_id);
    IF bad = 0 THEN
      ALTER TABLE "upload_image_metadata" ADD CONSTRAINT "uim_fact_id_fk"
        FOREIGN KEY ("fact_id") REFERENCES "facts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    ELSE
      ALTER TABLE "upload_image_metadata" ADD CONSTRAINT "uim_fact_id_fk"
        FOREIGN KEY ("fact_id") REFERENCES "facts"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
    END IF;
    RAISE NOTICE '[0112] uim_fact_id_fk restored (existing rows breaking it: %)', bad;
  END IF;

  -- 0055_upload_image_metadata_is_profile
  IF to_regclass('"UQ_uim_user_is_profile"') IS NULL THEN
    SELECT count(*) INTO bad FROM (
      SELECT user_id FROM upload_image_metadata WHERE is_profile = true GROUP BY user_id HAVING count(*) > 1
    ) dup;
    IF bad = 0 THEN
      CREATE UNIQUE INDEX "UQ_uim_user_is_profile" ON "upload_image_metadata" ("user_id") WHERE is_profile = true;
      RAISE NOTICE '[0112] UQ_uim_user_is_profile restored';
    ELSE
      RAISE NOTICE '[0112] UQ_uim_user_is_profile NOT restored: % user(s) hold more than one profile photo', bad;
    END IF;
  END IF;
END $$;
--> statement-breakpoint

-- 0051_memes_creator_created_at_index
CREATE INDEX IF NOT EXISTS "idx_memes_created_by_id_created_at"
  ON "memes" ("created_by_id", "created_at")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- 0071_facts_enrichment_overrides
CREATE INDEX IF NOT EXISTS "facts_has_overrides_idx"
  ON "facts" ("id")
  WHERE "enrichment_overrides" <> '{}'::jsonb;
--> statement-breakpoint

-- 0076_moderation_render_scenarios
CREATE INDEX IF NOT EXISTS "IDX_ipa_review_only"
  ON "image_prompt_attempts" ("review_id")
  WHERE "review_id" IS NOT NULL;
--> statement-breakpoint

-- 0081_eval_harness
CREATE INDEX IF NOT EXISTS "IDX_ipa_eval_run_fact_created"
  ON "image_prompt_attempts" ("eval_run_id", "fact_id", "created_at" DESC)
  WHERE "eval_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_ipa_eval_fact_run_created"
  ON "image_prompt_attempts" ("fact_id", "eval_run_id", "created_at" DESC)
  WHERE "eval_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_facts_eval_golden" ON "facts" ("id") WHERE "eval_golden";
