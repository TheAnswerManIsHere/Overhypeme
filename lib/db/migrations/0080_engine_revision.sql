-- Stale-fact refresh PR3: the manual "engine revision" marker + its audit log.
--
-- `engine_revision` (admin_config) is the manual half of a fact's
-- ProcessingSignature: an admin bumps it via Taxonomy Health "Mark major
-- update" when the engine/LLM changes, which flags facts processed under an
-- older revision as stale-for-reprocess. `engine_revision_bumps` records each
-- bump (old→new, who, optional note) so a corpus-wide invalidation is auditable.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) per repo migration
-- discipline; the hash-based runner (migrate.ts) treats already-exists DDL as
-- pre-applied. Source of truth: lib/db/src/schema/engineRevisionBumps.ts.
CREATE TABLE IF NOT EXISTS "engine_revision_bumps" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "old_revision" integer NOT NULL,
    "new_revision" integer NOT NULL,
    "note" text,
    "performed_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_erb_created_at" ON "engine_revision_bumps" ("created_at" DESC);
--> statement-breakpoint
-- Seed the marker at 1. ON CONFLICT DO NOTHING so a re-run never resets a value
-- an admin has already bumped.
INSERT INTO "admin_config" ("key", "value", "data_type", "label", "description", "is_public")
VALUES (
    'engine_revision',
    '1',
    'integer',
    'Engine Revision',
    'Manual marker bumped on a major engine/LLM change. Facts whose enrichment was processed under an older revision read as stale for reprocess in Taxonomy Health.',
    false
)
ON CONFLICT ("key") DO NOTHING;
