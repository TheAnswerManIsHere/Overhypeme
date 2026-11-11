-- Image tracing, increment 1 (plan docs/plans/PLAN_IMAGE_TRACING.md, "Data
-- Model and Migration Impact"; #905, #907): the provenance record every
-- picture gets at creation, and the generation request captured before a
-- vendor is called.
--
-- EXPAND, NOT CONTRACT: two new tables and one config row, nothing the
-- previous release reads or writes, so it keeps working unchanged.
-- Row states: both tables start empty; nothing is backfilled (David,
-- 2026-11-10: "All images will be new from the time we launch.").
--
-- Neither table has a foreign key. A record names memes, attempts, cells,
-- uploads, facts and users by plain value, so no deletion anywhere can cascade
-- into it or null it: the record outlives the picture, the meme and the
-- account (plan, Settled Decision 2).
-- Idempotent: every statement finds its own work done and skips it.
CREATE TABLE IF NOT EXISTS "image_generation_requests" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "producer" varchar(24) NOT NULL,
  "engine_id" varchar(64),
  "endpoint_id" text NOT NULL,
  "request" jsonb NOT NULL,
  "vendor_request_id" text,
  "attempt_id" bigint,
  "comparison_cell_id" bigint,
  "fact_id" integer,
  "actor_kind" varchar(12) NOT NULL,
  "actor_user_id" varchar,
  "actor_email" text,
  "source_commit" varchar(40),
  "source_commit_at" timestamp with time zone,
  "source_commit_title" text,
  "deployment_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "image_generation_requests_producer_check" CHECK (((producer)::text = ANY (ARRAY[('product_render'::character varying)::text, ('review_render'::character varying)::text, ('eval_render'::character varying)::text, ('comparison_cell'::character varying)::text, ('engine_workbench'::character varying)::text]))),
  CONSTRAINT "image_generation_requests_actor_kind_check" CHECK (((actor_kind)::text = ANY (ARRAY[('member'::character varying)::text, ('admin'::character varying)::text, ('anonymous'::character varying)::text, ('system'::character varying)::text])))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_igr_attempt_id" ON "image_generation_requests" ("attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_igr_comparison_cell_id" ON "image_generation_requests" ("comparison_cell_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_igr_vendor_request_id" ON "image_generation_requests" ("vendor_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_igr_created_at" ON "image_generation_requests" ("created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_provenance" (
  "id" bigint PRIMARY KEY NOT NULL,
  "kind" varchar(24) NOT NULL,
  "generation_request_id" bigint,
  "source_provenance_id" bigint,
  "actor_kind" varchar(12) NOT NULL,
  "actor_user_id" varchar,
  "actor_email" text,
  "meme_slug" varchar(16),
  "object_path" text,
  "attempt_id" bigint,
  "comparison_cell_id" bigint,
  "fact_id" integer,
  "engine_id" varchar(64),
  "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "mime" varchar(32) NOT NULL,
  "byte_size" integer NOT NULL,
  "width" integer,
  "height" integer,
  "watermark_scheme" varchar(32),
  "source_commit" varchar(40),
  "source_commit_at" timestamp with time zone,
  "source_commit_title" text,
  "deployment_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "image_provenance_kind_check" CHECK (((kind)::text = ANY (ARRAY[('ai_render'::character varying)::text, ('comparison_cell'::character varying)::text, ('workbench'::character varying)::text, ('upload'::character varying)::text, ('meme_bake'::character varying)::text, ('meme_live'::character varying)::text, ('preview'::character varying)::text, ('download'::character varying)::text]))),
  CONSTRAINT "image_provenance_actor_kind_check" CHECK (((actor_kind)::text = ANY (ARRAY[('member'::character varying)::text, ('admin'::character varying)::text, ('anonymous'::character varying)::text, ('system'::character varying)::text])))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_image_provenance_sha256" ON "image_provenance" ("sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_image_provenance_object_path" ON "image_provenance" ("object_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_image_provenance_meme_slug" ON "image_provenance" ("meme_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_image_provenance_attempt_id" ON "image_provenance" ("attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_image_provenance_comparison_cell_id" ON "image_provenance" ("comparison_cell_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_image_provenance_created_at" ON "image_provenance" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_image_provenance_generation_request_id" ON "image_provenance" ("generation_request_id");--> statement-breakpoint
-- The retention setting (plan, Settled): 0 means records never expire.
INSERT INTO "admin_config" ("key", "value", "data_type", "label", "description", "min_value")
VALUES ('image_provenance.retention_days', '0', 'integer', 'Image provenance retention (days; 0 = kept indefinitely)', 'How long a picture''s provenance record is kept after it is made. 0 keeps every record indefinitely (David, 2026-11-10); Phase 14''s legal read may set a period.', 0)
ON CONFLICT ("key") DO NOTHING;
