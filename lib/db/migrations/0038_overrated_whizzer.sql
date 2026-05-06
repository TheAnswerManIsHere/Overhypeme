ALTER TYPE "public"."review_reason" ADD VALUE 'lame';--> statement-breakpoint
CREATE TABLE "oauth_pending_states" (
        "state" varchar PRIMARY KEY NOT NULL,
        "code_verifier" text NOT NULL,
        "nonce" text NOT NULL,
        "return_to" text DEFAULT '/' NOT NULL,
        "is_popup" boolean DEFAULT false NOT NULL,
        "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactions" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" varchar NOT NULL,
        "target_type" varchar(16) NOT NULL,
        "target_id" integer NOT NULL,
        "reaction_type" varchar(16) NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_checkout_request_ledger" (
        "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stripe_checkout_request_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
        "user_id" varchar NOT NULL,
        "price_id" varchar NOT NULL,
        "request_key" varchar NOT NULL,
        "session_id" varchar NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "stripe_checkout_request_ledger_request_key_unique" UNIQUE("request_key")
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_audit" (
        "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stripe_webhook_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
        "event_id" text NOT NULL,
        "event_type" text NOT NULL,
        "state" varchar NOT NULL,
        "detail" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
        "key_hash" varchar(64) PRIMARY KEY NOT NULL,
        "key_raw" text NOT NULL,
        "count" integer DEFAULT 0 NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "heart_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "heart_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD COLUMN "source" varchar(64);--> statement-breakpoint
ALTER TABLE "user_fact_preferences" ADD COLUMN "last_seen_as_hero_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_checkout_request_ledger" ADD CONSTRAINT "stripe_checkout_request_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_oauth_pending_states_expires_at" ON "oauth_pending_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_reactions_user_target_type" ON "reactions" USING btree ("user_id","target_type","target_id","reaction_type");--> statement-breakpoint
CREATE INDEX "IDX_reactions_target" ON "reactions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "IDX_reactions_user" ON "reactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_checkout_request_ledger_user_id" ON "stripe_checkout_request_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_audit_event_id" ON "stripe_webhook_audit" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_audit_created_at" ON "stripe_webhook_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_rate_limit_counters_expires_at" ON "rate_limit_counters" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "IDX_memes_heart_count" ON "memes" USING btree ("heart_count");--> statement-breakpoint
CREATE INDEX "ufp_user_seen_hero_idx" ON "user_fact_preferences" USING btree ("user_id","last_seen_as_hero_at");--> statement-breakpoint
CREATE INDEX "email_outbox_status_created_idx" ON "email_outbox" USING btree ("status","created_at" DESC NULLS LAST);