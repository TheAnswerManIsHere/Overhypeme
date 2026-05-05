-- Composite index on (status, created_at) for the email_outbox table.
-- Keeps admin queue page queries and status-filtered counts fast as the
-- table accumulates delivered/abandoned history over the 30-day retention window.
CREATE INDEX IF NOT EXISTS "email_outbox_status_created_idx"
  ON "email_outbox" ("status", "created_at" DESC);
