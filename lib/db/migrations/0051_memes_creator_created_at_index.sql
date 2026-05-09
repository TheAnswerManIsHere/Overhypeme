-- Phase 4: index covering the per-user daily save-cap query.
--
-- POST /api/memes enforces a rolling 24h cap by counting recent live memes for
-- the authenticated user:
--   SELECT COUNT(*) FROM memes
--   WHERE created_by_id = $1 AND created_at > now() - interval '24 hours'
--     AND deleted_at IS NULL
--
-- The same index also speeds up the idempotency lookup, which scans the same
-- (created_by_id, created_at) slice within the last 60 seconds for a matching
-- input hash. Partial on `deleted_at IS NULL` because soft-deleted memes are
-- never relevant to either query.

CREATE INDEX IF NOT EXISTS "idx_memes_created_by_id_created_at"
  ON "memes" ("created_by_id", "created_at")
  WHERE "deleted_at" IS NULL;
