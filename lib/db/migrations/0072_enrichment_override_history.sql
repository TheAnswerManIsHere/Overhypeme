-- Audit history for manual taxonomy-enrichment overrides.
--
-- One row per override mutation (set | update | reset | auto_linked |
-- baseline_reenriched). `baseline_reenriched` rows are written only on a
-- not-changed → changed transition, never one noisy row per unchanged override
-- on every re-enrich.

CREATE TABLE IF NOT EXISTS "enrichment_override_history" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "fact_id" integer NOT NULL REFERENCES "facts"("id") ON DELETE CASCADE,
    "path" varchar(64) NOT NULL,
    "action" varchar(24) NOT NULL,
    "old_value" jsonb,
    "new_value" jsonb,
    "ai_generation_id" varchar(64),
    "reason" text,
    "performed_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_eoh_fact_id" ON "enrichment_override_history" ("fact_id");
CREATE INDEX IF NOT EXISTS "IDX_eoh_created_at" ON "enrichment_override_history" ("created_at" DESC);
