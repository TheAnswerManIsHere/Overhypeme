-- Job leases (plan docs/plans/PLAN_JOB_RESUME.md, Issue #1000, increment 1,
-- Issue #1007; approved by David 2026-11-17). Expand only, no backfill.
--
-- Every claim now records who holds it and until when:
--   claim_owner               the claiming process's instance id (the id
--                             worker_lane_heartbeats uses)
--   lease_token               a fresh token per claim; every finish and every
--                             fenced effect must present it
--   lease_expires_at          renewed every 20 s while the holder lives; a
--                             processing row whose lease has lapsed is reclaimed
--   claimed_at                when this claim was taken (the 30-minute rule for a
--                             queue whose fast reclaim is off counts from here)
--   claim_recovery_protocol   the recovery protocol the claiming handler
--                             declares for its queue (null: none)
--   recovery_protocol         non-null only on a row taken back from a stopped
--                             holder for a queue that declares recovery: the
--                             minimum protocol a worker must declare to claim it.
--                             Sticky until the job finishes.
--
-- A new status, 'recovering', is claimable only by a handler declaring at least
-- recovery_protocol. No code emits it in this release; the dedupe index is
-- widened now so a 'recovering' row is in flight for dedupe before one exists.
--
-- Row-state matrix:
--   pending / done / failed rows           untouched; new columns null.
--   processing rows claimed by the previous release (no lease_token)
--                                          keep the 30-minute rule (updated_at).
--   rows written by the previous release after this ran
--                                          same as above: nulls, read correctly.
--   recovering rows                        none exist; the widened predicate admits
--                                          exactly the rows the old one did.
-- Previous release on this schema: it never reads or writes the new columns,
-- claims only 'pending', and its dedupe lookup matches the same rows.
--
-- Rollback: revert the code and keep the columns (nullable, ignored by the old
-- code). Idempotent: every statement is IF [NOT] EXISTS, and the index rebuild
-- ends in the same state on replay.
ALTER TABLE "async_jobs" ADD COLUMN IF NOT EXISTS "claim_owner" varchar(64);
ALTER TABLE "async_jobs" ADD COLUMN IF NOT EXISTS "lease_token" varchar(64);
ALTER TABLE "async_jobs" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;
ALTER TABLE "async_jobs" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
ALTER TABLE "async_jobs" ADD COLUMN IF NOT EXISTS "claim_recovery_protocol" integer;
ALTER TABLE "async_jobs" ADD COLUMN IF NOT EXISTS "recovery_protocol" integer;

DROP INDEX IF EXISTS "async_jobs_dedupe_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "async_jobs_dedupe_idx"
  ON "async_jobs" USING btree ("queue", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "status" IN ('pending', 'processing', 'recovering');

CREATE INDEX IF NOT EXISTS "async_jobs_recovering_idx"
  ON "async_jobs" USING btree ("queue", "next_attempt_at")
  WHERE "status" = 'recovering';

CREATE INDEX IF NOT EXISTS "async_jobs_lease_idx"
  ON "async_jobs" USING btree ("lease_expires_at")
  WHERE "status" = 'processing';
