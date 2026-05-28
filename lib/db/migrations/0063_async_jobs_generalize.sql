-- Generalize the email_outbox worker into a shared async-jobs queue.
--
-- Renames the table and evolves the columns in place so existing email rows
-- survive the migration: their email-specific columns are coalesced into a
-- single `payload` jsonb. After the migration the original email columns are
-- dropped; the application reads them back out of `payload`.
--
-- Producers must enqueue with queue + payload (+ optional dedupe_key +
-- external_id for queues that submit to an external service and poll).

ALTER TABLE "email_outbox" RENAME TO "async_jobs";--> statement-breakpoint

ALTER TABLE "async_jobs" ADD COLUMN "queue" varchar(64) DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "async_jobs" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "async_jobs" ADD COLUMN "external_id" varchar(255);--> statement-breakpoint
ALTER TABLE "async_jobs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "async_jobs" ADD COLUMN "dedupe_key" varchar(255);--> statement-breakpoint

-- Backfill payload from the email-specific columns so existing pending rows
-- continue to deliver. (null html/kind become absent json keys.)
UPDATE "async_jobs" SET "payload" = jsonb_strip_nulls(
  jsonb_build_object(
    'to', "to",
    'subject', "subject",
    'text', "text",
    'html', "html",
    'kind', "kind"
  )
) WHERE "payload" IS NULL;--> statement-breakpoint

-- Normalize the legacy email-specific status vocabulary to the generic one.
-- Old (email_outbox)  → New (async_jobs)
--   pending           →  pending     (no change)
--   sending           →  processing
--   delivered         →  done
--   abandoned         →  failed
UPDATE "async_jobs" SET "status" = 'processing' WHERE "status" = 'sending';--> statement-breakpoint
UPDATE "async_jobs" SET "status" = 'done'       WHERE "status" = 'delivered';--> statement-breakpoint
UPDATE "async_jobs" SET "status" = 'failed'     WHERE "status" = 'abandoned';--> statement-breakpoint

ALTER TABLE "async_jobs" ALTER COLUMN "payload" SET NOT NULL;--> statement-breakpoint

-- Drop the email-specific columns; the email handler now reads from payload.
ALTER TABLE "async_jobs" DROP COLUMN "to";--> statement-breakpoint
ALTER TABLE "async_jobs" DROP COLUMN "subject";--> statement-breakpoint
ALTER TABLE "async_jobs" DROP COLUMN "text";--> statement-breakpoint
ALTER TABLE "async_jobs" DROP COLUMN "html";--> statement-breakpoint
ALTER TABLE "async_jobs" DROP COLUMN "kind";--> statement-breakpoint

-- Drop the old email-shaped indexes and create the generic ones.
DROP INDEX IF EXISTS "email_outbox_pending_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "email_outbox_status_created_idx";--> statement-breakpoint

CREATE INDEX "async_jobs_pending_idx" ON "async_jobs" USING btree ("queue","next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "async_jobs_status_created_idx" ON "async_jobs" USING btree ("queue","status","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "async_jobs_dedupe_idx" ON "async_jobs" USING btree ("queue","dedupe_key") WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing');
