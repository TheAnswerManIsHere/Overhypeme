-- Rebuild three indexes that were created without DESC NULLS LAST in their
-- original migration SQL, even though the TypeScript schema specifies
-- .desc().nullsLast().  The mismatch caused drizzle-kit to report schema
-- drift on every Replit publish (DROP + CREATE for each affected index).
--
-- Affected indexes:
--   email_outbox_status_created_idx  (email_outbox.status, created_at)
--   IDX_quarantined_source_created   (quarantined_memes.source, created_at)
--   IDX_quarantined_user_created     (quarantined_memes.user_id, created_at)
--
-- DROP IF EXISTS + CREATE makes each block idempotent regardless of whether
-- the index currently exists or which sort order it uses.
DROP INDEX IF EXISTS "email_outbox_status_created_idx";
--> statement-breakpoint
CREATE INDEX "email_outbox_status_created_idx"
  ON "email_outbox" USING btree ("status", "created_at" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX IF EXISTS "IDX_quarantined_source_created";
--> statement-breakpoint
CREATE INDEX "IDX_quarantined_source_created"
  ON "quarantined_memes" USING btree ("source", "created_at" DESC NULLS LAST);
--> statement-breakpoint
DROP INDEX IF EXISTS "IDX_quarantined_user_created";
--> statement-breakpoint
CREATE INDEX "IDX_quarantined_user_created"
  ON "quarantined_memes" USING btree ("user_id", "created_at" DESC NULLS LAST);
