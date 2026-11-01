-- Launch Phase 5, increment 4 (#795; plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- 0115). EXPAND: what My content needs to make every deletion undoable, and
-- the record that a meme is a stored file (plan S2, S16).
--
--   * memes.purge_after — when a meme its owner deleted is destroyed
--     (deleted_at + the restore window). memes.deleted_at already exists.
--   * memes.baked_at — when the meme's JPEG was rendered from its recipe and
--     stored at memeKey(slug). The server bakes every new meme at save; the
--     boot backfill (lib/memeBake.ts, backfillMemeBakes) bakes recipe memes
--     saved before this, which is a renderer-and-storage job, not SQL.
--   * user_ai_images and upload_image_metadata gain deleted_at and
--     purge_after, so a photo or an AI image can be deleted and restored too.
--   * partial indexes for the live listings, the purge job's selection and the
--     backfill's (empty once every recipe meme is baked).
--
-- Row states:
--   * existing memes — purge_after stays null. A meme already deleted before
--     this (0103/0106/0107's retired content included) keeps its deleted_at
--     with purge_after null: not live, not restorable, never purged.
--     baked_at stays null until the backfill bakes it; a legacy meme stored as
--     a file before recipes existed (image_source null) is never selected.
--   * existing uploads and AI images — both new columns null: live.
--   * no row is rewritten by this migration.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.

ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;
ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "baked_at" timestamp with time zone;
ALTER TABLE "upload_image_metadata" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "upload_image_metadata" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;
ALTER TABLE "user_ai_images" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "user_ai_images" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "IDX_memes_purge_after" ON "memes" ("purge_after") WHERE "purge_after" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "IDX_memes_unbaked" ON "memes" ("id") WHERE "baked_at" IS NULL AND "image_source" IS NOT NULL AND "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "IDX_uim_user_live" ON "upload_image_metadata" ("user_id") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "IDX_uim_purge_after" ON "upload_image_metadata" ("purge_after") WHERE "purge_after" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "IDX_uai_user_live" ON "user_ai_images" ("user_id") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "IDX_uai_purge_after" ON "user_ai_images" ("purge_after") WHERE "purge_after" IS NOT NULL;

DO $$
DECLARE
  to_bake bigint;
  tombstones bigint;
BEGIN
  SELECT count(*) INTO to_bake FROM memes WHERE image_source IS NOT NULL AND baked_at IS NULL AND deleted_at IS NULL AND status <> 'quarantined';
  SELECT count(*) INTO tombstones FROM memes WHERE deleted_at IS NOT NULL;
  RAISE NOTICE '[0115] recipe memes the boot backfill will bake: %; deleted memes kept as non-restorable tombstones: %', to_bake, tombstones;
END $$;
