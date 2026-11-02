-- Launch Phase 5, increment 6a (plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- "Suspension", S19; intent item 8): an admin can suspend an account. A
-- suspended account cannot sign in or act; the reason is visible to admins
-- only; the person's catalogue content is untouched.
--
-- 1. users.suspended_at / suspended_reason / suspended_by — the suspension
--    record. `is_active` is never written by suspension (S19): it keeps its
--    one meaning, the lockout guard's purge reservation.
-- 2. Legacy admin "deactivation" (is_active = false) becomes suspension:
--    those rows get suspended_at = updated_at, the reason 'legacy
--    deactivation', and is_active back to true, so the sign-in paths and the
--    admin count that still read is_active see one meaning, and unsuspending
--    has nothing else to undo. A row with an active deletion request is left
--    alone (it is the deletion engine's).
--
-- Row states: active accounts untouched (suspended_at null); deactivated
-- accounts become suspended; a row that is both deactivated and leaving is
-- unchanged. Idempotent: ADD COLUMN IF NOT EXISTS; the backfill selects only
-- is_active = false rows, which it turns true, so a second run moves nothing.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_reason" varchar(500);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_by" varchar;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_suspended_by_users_id_fk' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_suspended_by_users_id_fk"
      FOREIGN KEY ("suspended_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE
  moved bigint;
BEGIN
  UPDATE users u
     SET suspended_at = COALESCE(u.suspended_at, u.updated_at),
         suspended_reason = COALESCE(u.suspended_reason, 'legacy deactivation'),
         is_active = true
   WHERE u.is_active = false
     AND NOT EXISTS (
       SELECT 1 FROM account_deletion_requests r
        WHERE r.user_id = u.id AND r.cancelled_at IS NULL AND r.stage <> 'done'
     );
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '[0120] deactivated accounts now suspended: %', moved;
END $$;
