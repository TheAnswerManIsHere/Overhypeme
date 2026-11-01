-- Launch Phase 5, increment 5 (#795; plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- the plan's "0116", renumbered when 0116 seeded the restore window). EXPAND:
-- what the account deletion engine (lib/accountDeletion.ts, plan S14) records.
--
--   * account_deletion_requests — one row per account asked to be deleted:
--     when, when its purge may run (14 days later, or now for an admin's
--     "purge now"), whether it was cancelled, and the stage the engine has
--     reached. A stage only advances by compare-and-set on the one before,
--     so a cancel and the purge can never both win. ON DELETE CASCADE: the
--     row goes with the account at the end of the purge. No index beyond the
--     primary key: the live rule probes it by user_id, and the hourly worker
--     reads a table that only ever holds pending requests.
--   * facts.submitter_deleted_at — set when the purge nulls a fact's
--     submitter, so a fact whose submitter left reads apart from one that
--     never had one (plan S3).
--
-- requested_at is the request's generation: every stage change is fenced to
-- it, so it is always written by the engine (never left to its default).
-- billing_unsettled is true from the first Stripe cancel until every source
-- has been refreshed, and survives a cancel, so keeping the account cannot
-- leave a cancelled subscription granting access.
--
-- Row states: no existing row is touched. A request is "active" while
-- cancelled_at is null and stage is not 'done'.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- and the CHECK added only when absent.

CREATE TABLE IF NOT EXISTS "account_deletion_requests" (
  "user_id" varchar PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "purge_after" timestamp with time zone NOT NULL,
  "requested_by" varchar(16) NOT NULL,
  "cancelled_at" timestamp with time zone,
  "stage" varchar(24) DEFAULT 'accepted' NOT NULL,
  "stage_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "hold_reason" text,
  "last_error" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "billing_unsettled" boolean DEFAULT false NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_deletion_requests_stage_check' AND conrelid = 'account_deletion_requests'::regclass) THEN
    -- Written in the form PostgreSQL prints for the schema's declaration, so
    -- a database built by these migrations and one built by a schema push
    -- carry the same text (0114's practice).
    ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_stage_check"
      CHECK (((stage)::text = ANY ((ARRAY['accepted'::character varying, 'subscription_cancelled'::character varying, 'notified'::character varying, 'held'::character varying, 'purging'::character varying, 'done'::character varying])::text[])));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_deletion_requests_requested_by_check' AND conrelid = 'account_deletion_requests'::regclass) THEN
    ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_requested_by_check"
      CHECK (((requested_by)::text = ANY ((ARRAY['self'::character varying, 'admin'::character varying, 'unonboarded'::character varying])::text[])));
  END IF;
END $$;

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "submitter_deleted_at" timestamp with time zone;
