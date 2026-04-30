CREATE TABLE IF NOT EXISTS "stripe_webhook_audit" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "state" varchar NOT NULL,
  "detail" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_stripe_webhook_audit_event_id" ON "stripe_webhook_audit" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_stripe_webhook_audit_created_at" ON "stripe_webhook_audit" ("created_at");
