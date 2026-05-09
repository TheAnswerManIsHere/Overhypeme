-- Phase 4: transient_renders metrics table.
--
-- Tracks every call to /api/render-preview and /api/render-download for abuse
-- detection and per-user analytics. The render endpoints persist no image
-- bytes — this table is the only durable record that a render happened.
--
-- IPs are stored hashed with a server-side salt so the table can be queried
-- by source-IP without retaining raw addresses (Phase-1 audit-PII principle).
-- Rows are purged by a scheduled job after `transient_renders.retention_days`
-- (default 30 days) — see jobs/transientRenderPurger.ts.

CREATE TABLE IF NOT EXISTS "transient_renders" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "endpoint" varchar(16) NOT NULL,
  "fact_id" integer REFERENCES "facts"("id") ON DELETE SET NULL,
  "user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "ip_hash" text NOT NULL,
  "mode" varchar(24),
  "result" varchar(12) NOT NULL,
  "rejection_reason" text,
  "latency_ms" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transient_renders_ip_hash_created_at"
  ON "transient_renders" ("ip_hash", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transient_renders_user_id_created_at"
  ON "transient_renders" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transient_renders_created_at"
  ON "transient_renders" ("created_at");
