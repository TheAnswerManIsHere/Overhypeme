CREATE TABLE IF NOT EXISTS "stripe_checkout_request_ledger" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id" varchar NOT NULL REFERENCES "users"("id"),
  "price_id" varchar NOT NULL,
  "request_key" varchar NOT NULL UNIQUE,
  "session_id" varchar NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_checkout_request_ledger_user_id" ON "stripe_checkout_request_ledger" ("user_id");
