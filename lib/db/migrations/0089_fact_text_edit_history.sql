-- Approved-fact-text lock (Plan v4): audit history for the rare, dire-warning-
-- gated edit of an ALREADY-APPROVED fact's text, plus the lookup index the
-- protection predicate needs. One row per confirmed protected text change; the
-- never-approved staging-edit path writes no row. The insert shares the
-- facts.text mutation transaction, so audit + mutation commit or roll back
-- together.
--
-- Hand-written idempotent DDL per repo migration discipline (drizzle-kit
-- generate is broken on the pre-existing malformed 0063 snapshot). Source of
-- truth: lib/db/src/schema/{factTextEditHistory,reviews}.ts.

-- ── fact_text_edit_history: audit trail for approved-fact text edits ──────────
-- performed_by is nullable ON DELETE SET NULL (mirrors enrichment_override_history)
-- so hard-deleting an admin never deletes or blocks the audit history.
CREATE TABLE IF NOT EXISTS "fact_text_edit_history" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "fact_id" integer NOT NULL REFERENCES "facts"("id") ON DELETE CASCADE,
    "old_text" text NOT NULL,
    "new_text" text NOT NULL,
    "reason" text NOT NULL,
    "performed_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The one query this table serves: fact-scoped, newest-first history for the
-- admin fact panel. A single compound index covers it.
CREATE INDEX IF NOT EXISTS "IDX_fteh_fact_created" ON "fact_text_edit_history" ("fact_id", "created_at" DESC);
--> statement-breakpoint

-- Protection predicate lookup: "is there a production-approved review pointing
-- at this fact?" (approvedFactId existence), run per text-bearing admin PATCH.
CREATE INDEX IF NOT EXISTS "idx_pending_reviews_approved_fact" ON "pending_reviews" ("approved_fact_id");
