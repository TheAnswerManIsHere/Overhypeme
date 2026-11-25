-- A durable list of stored files still to delete (Issue #1304, increment A;
-- plan docs/plans/PLAN_RENDER_HISTORY.md D6 and D7). EXPAND only: one new
-- table. Nothing the previous release reads or writes changes.
--
-- A row is written in the same transaction as the database delete that leaves
-- its file unreferenced (a purged rejected submission's renders now, a deleted
-- render in increment B), so the row and the obligation to remove its file
-- commit or roll back together. The file is removed after the commit, at once
-- and then by an hourly sweep, which retries anything outstanding. An object
-- already missing counts as removed. Nothing is ever abandoned silently: each
-- path keeps its reason, attempts and last error until it is done, and the
-- outstanding count shows on Queue Health.
--
-- One open row per path (done_at IS NULL): queuing a path already waiting is
-- a no-op, so a re-run or two writers never make a second obligation. A path
-- done once and queued again (a later delete that happens to name it) gets a
-- new row.
--
-- Row-state matrix: none. The table is new and starts empty; no backfill.
-- Rollback: DROP TABLE stored_file_deletions; the previous release never reads
-- it. Outstanding rows would then be files left in storage, which the media
-- backup's seven-day window does not affect.

CREATE TABLE IF NOT EXISTS stored_file_deletions (
  id bigserial PRIMARY KEY,
  path text NOT NULL,
  reason varchar(48) NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  done_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_stored_file_deletions_open_path"
  ON stored_file_deletions (path) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS "IDX_stored_file_deletions_outstanding"
  ON stored_file_deletions (created_at) WHERE done_at IS NULL;
