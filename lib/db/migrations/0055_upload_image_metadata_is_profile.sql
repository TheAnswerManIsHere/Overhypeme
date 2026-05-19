-- Task #507: tag the user's profile photo inside upload_image_metadata so the
-- meme builder, Edit Profile, and any future surfaces can treat it as just
-- another library entry (with a badge) instead of a parallel
-- `users.profileImageUrl` plumbing path.
--
-- 1. Add the boolean column (default false, NOT NULL).
-- 2. Add a partial unique index so a user can only ever have one profile
--    photo at a time.
-- 3. Backfill: for every user whose `profile_image_url` is a first-party
--    storage URL (`/api/storage/objects/...`), upsert a row marking the
--    derived object_path as the profile photo. Idempotent — re-running
--    leaves existing rows' dimensions/scan metadata untouched and only
--    toggles `is_profile`.

ALTER TABLE "upload_image_metadata"
  ADD COLUMN IF NOT EXISTS "is_profile" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_uim_user_is_profile"
  ON "upload_image_metadata" ("user_id")
  WHERE is_profile = true;
--> statement-breakpoint

-- Backfill. For each user whose profile_image_url begins with the first-party
-- storage prefix, derive object_path = '/objects/<rest>' and insert (or update
-- in place) a row with is_profile=true. Width/height/file_size_bytes are
-- required columns; for the backfill INSERT path we record zeros — the meme
-- builder treats those as "unknown" and recomputes on demand. The ON CONFLICT
-- DO UPDATE path only toggles `is_profile` and `user_id`, leaving dimensions
-- and moderation columns intact for rows that were already moderated.
INSERT INTO "upload_image_metadata" (
  object_path, width, height, is_low_res, file_size_bytes, user_id, is_profile
)
SELECT
  '/objects/' || substring(u.profile_image_url FROM length('/api/storage/objects/') + 1) AS object_path,
  0 AS width,
  0 AS height,
  false AS is_low_res,
  0 AS file_size_bytes,
  u.id AS user_id,
  true AS is_profile
FROM "users" u
WHERE u.profile_image_url LIKE '/api/storage/objects/%'
ON CONFLICT (object_path) DO UPDATE
  SET is_profile = true,
      user_id    = COALESCE("upload_image_metadata".user_id, EXCLUDED.user_id);
