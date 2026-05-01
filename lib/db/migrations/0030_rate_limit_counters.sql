CREATE TABLE IF NOT EXISTS "rate_limit_counters" (
  "key_hash" varchar(64) PRIMARY KEY NOT NULL,
  "key_raw" text NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rate_limit_counters_expires_at" ON "rate_limit_counters" ("expires_at");
