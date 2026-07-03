-- Stale-fact refresh: versioned enrichment.
--
-- `facts.*` stays the SOLE active enrichment truth (Option B). This table is an
-- append-only archive + in-flight candidate store: statuses candidate |
-- promoted | superseded | rejected (never 'active'). See factEnrichmentVersions.ts.
--
-- Idempotent (IF NOT EXISTS) per repo migration discipline; the hash-based
-- runner (migrate.ts) also treats already-exists DDL as pre-applied.
CREATE TABLE IF NOT EXISTS "fact_enrichment_versions" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "fact_id" integer NOT NULL REFERENCES "facts"("id") ON DELETE CASCADE,
    "version_no" integer NOT NULL,
    "status" varchar(16) NOT NULL,
    "enrichment" jsonb,
    "enrichment_ai_derived" jsonb,
    "enrichment_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "visual_override" jsonb,
    "fact_text_hash" text,
    "signature" jsonb,
    "source" varchar(24) NOT NULL,
    "source_review_id" integer REFERENCES "pending_reviews"("id") ON DELETE SET NULL,
    "note" text,
    "created_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "promoted_at" timestamp with time zone,
    "superseded_at" timestamp with time zone,
    "rejected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_fev_fact_id" ON "fact_enrichment_versions" ("fact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_fev_fact_status" ON "fact_enrichment_versions" ("fact_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fev_fact_version_no" ON "fact_enrichment_versions" ("fact_id","version_no");
--> statement-breakpoint
-- At most one in-flight candidate per fact. Covers 'candidate' ONLY so historical
-- rejected/superseded/promoted rows never block a new refresh.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fev_one_candidate_per_fact" ON "fact_enrichment_versions" ("fact_id") WHERE "status" = 'candidate';
--> statement-breakpoint
ALTER TABLE "pending_reviews" ADD COLUMN IF NOT EXISTS "candidate_version_id" bigint;
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "last_processed_signature" jsonb;
