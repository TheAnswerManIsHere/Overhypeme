-- Persists OAuth PKCE state in the database so that a server restart
-- mid-login flow does not wipe pending state and cause an infinite redirect
-- loop back to the provider.
CREATE TABLE IF NOT EXISTS "oauth_pending_states" (
  "state" varchar PRIMARY KEY,
  "code_verifier" text NOT NULL,
  "nonce" text NOT NULL,
  "return_to" text NOT NULL DEFAULT '/',
  "is_popup" boolean NOT NULL DEFAULT false,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_oauth_pending_states_expires_at"
  ON "oauth_pending_states" ("expires_at");
