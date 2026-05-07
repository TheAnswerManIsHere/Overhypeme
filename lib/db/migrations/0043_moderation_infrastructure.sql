CREATE TABLE "ncmec_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"report_id" varchar(64),
	"submitted_at" timestamp with time zone,
	"match_source" varchar(16) NOT NULL,
	"evidence_uri" text NOT NULL,
	"evidence_retention_until" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	"user_id" varchar,
	"request_metadata" jsonb,
	"submission_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quarantined_memes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"meme_id" integer,
	"user_id" varchar,
	"evidence_object_path" text NOT NULL,
	"source" varchar(20) NOT NULL,
	"match_type" varchar(10),
	"classification" varchar(40),
	"classifier_score" numeric(6, 4),
	"classifier_model" text,
	"raw_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "nsfw_mode_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "status" varchar(20) DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "nsfw_classifier_score" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "is_nsfw" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "arachnid_classification" varchar(40);--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "arachnid_match_type" varchar(10);--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "arachnid_sha1_base32" varchar(40);--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "arachnid_sha256_hex" varchar(64);--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "arachnid_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "is_nsfw" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantined_memes" ADD CONSTRAINT "quarantined_memes_meme_id_memes_id_fk" FOREIGN KEY ("meme_id") REFERENCES "public"."memes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantined_memes" ADD CONSTRAINT "quarantined_memes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_ncmec_status_created" ON "ncmec_reports" USING btree ("submission_status","created_at");--> statement-breakpoint
CREATE INDEX "IDX_quarantined_user_created" ON "quarantined_memes" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "IDX_quarantined_source_created" ON "quarantined_memes" USING btree ("source","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "IDX_quarantined_live" ON "quarantined_memes" USING btree ("id") WHERE "quarantined_memes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "IDX_memes_status" ON "memes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_uim_arachnid_sha256" ON "upload_image_metadata" USING btree ("arachnid_sha256_hex");--> statement-breakpoint

-- CHECK constraints for enum-like columns. Drizzle does not emit these for us.
ALTER TABLE "memes" ADD CONSTRAINT "memes_status_check"
  CHECK ("status" IN ('live','quarantined','rejected'));--> statement-breakpoint
ALTER TABLE "quarantined_memes" ADD CONSTRAINT "quarantined_memes_source_check"
  CHECK ("source" IN ('arachnid','fal_safety','classifier','manual'));--> statement-breakpoint
ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_match_source_check"
  CHECK ("match_source" IN ('arachnid','classifier'));--> statement-breakpoint
ALTER TABLE "ncmec_reports" ADD CONSTRAINT "ncmec_reports_submission_status_check"
  CHECK ("submission_status" IN ('pending','submitted','failed'));--> statement-breakpoint

-- Moderation config (admin_config). All rows are server-internal (is_public=false).
INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
  ('arachnid_shield_enabled', 'true', 'boolean', 'Arachnid Shield Enabled',
   'When true, every face-source upload is scanned via Project Arachnid Shield before storage.',
   NULL, NULL, false),
  ('arachnid_fail_open', 'false', 'boolean', 'Arachnid Fail-Open',
   'If false, upload is rejected when the Arachnid scan errors. Recommended: false.',
   NULL, NULL, false),
  ('nsfw_classifier_endpoint', 'fal-ai/imageutils/nsfw', 'text', 'NSFW Classifier Endpoint',
   'fal.ai endpoint id used as the synchronous NSFW gate on every generated/uploaded image.',
   NULL, NULL, false),
  ('nsfw_classifier_threshold', '0.85', 'text', 'NSFW Classifier Threshold',
   'Probability score at or above which an image is treated as NSFW. Stored as text so we can use floats.',
   NULL, NULL, false),
  ('nsfw_classifier_timeout_ms', '15000', 'integer', 'NSFW Classifier Timeout (ms)',
   'Max time to wait for the NSFW classifier before failing closed.',
   1000, 120000, false),
  ('fal_safety_tolerance_pulid', '1', 'text', 'fal.ai Safety Tolerance (PuLID/IP-Adapter)',
   'Strictest = "1". Applied to PuLID and IP-Adapter image generation when the model accepts it.',
   NULL, NULL, false),
  ('upload_rate_limit_registered_per_day', '20', 'integer', 'Upload Cap — Registered (per day)',
   'Daily face-source upload cap for free/registered users.',
   1, 1000, false),
  ('upload_rate_limit_legendary_per_day', '200', 'integer', 'Upload Cap — Legendary (per day)',
   'Daily face-source upload cap for Legendary tier users.',
   1, 10000, false),
  ('name_validation_max_words', '3', 'integer', 'Name Validation: Max Words',
   'Hard cap on the number of whitespace-separated words in displayName/firstName/lastName.',
   1, 10, false),
  ('name_validation_max_chars_per_word', '20', 'integer', 'Name Validation: Max Chars Per Word',
   'Hard cap on each word inside displayName/firstName/lastName.',
   1, 80, false),
  ('name_denylist_patterns', '[]', 'text', 'Name Denylist Patterns (JSON)',
   'JSON array of regex patterns rejected on name fields. Keep short — false positives are user-facing.',
   NULL, NULL, false),
  ('quarantine_evidence_retention_days', '90', 'integer', 'Quarantine Evidence Retention (days)',
   'Minimum days quarantined evidence must be preserved before deletion is permitted.',
   30, 365, false)
ON CONFLICT (key) DO NOTHING;