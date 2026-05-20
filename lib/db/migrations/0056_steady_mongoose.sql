CREATE TABLE "look_styles" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"label" varchar(128) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prompt_suffix" text DEFAULT '' NOT NULL,
	"prompt_suffix_reference" text DEFAULT '' NOT NULL,
	"preview_image_path" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engines" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"endpoint_id" varchar(128) NOT NULL,
	"label" varchar(128) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" varchar(16) NOT NULL,
	"tier_requirement" varchar(32) DEFAULT 'legendary' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"allowed_durations_sec" jsonb,
	"default_duration_sec" integer,
	"allowed_resolutions" jsonb,
	"default_resolution" varchar(16),
	"allowed_aspect_ratios" jsonb,
	"default_aspect_ratio" varchar(16),
	"supported_modes" jsonb,
	"default_mode" varchar(32),
	"audio_handling" varchar(32) DEFAULT 'none' NOT NULL,
	"param_schema" jsonb NOT NULL,
	"estimated_cost_usd_per_call" numeric(10, 6),
	"estimated_cost_usd_per_second" numeric(10, 6),
	"expected_run_ms" integer DEFAULT 30000 NOT NULL,
	"feature_flag_required" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_styles" RENAME TO "motion_presets";--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "artifact_type" varchar(10) DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "video_object_path" text;--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "video_job_id" integer;--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "look_style_id" varchar(64);--> statement-breakpoint
ALTER TABLE "memes" ADD COLUMN "motion_preset_id" varchar(64);--> statement-breakpoint
-- NOTE: `upload_image_metadata.is_profile` was added by migration 0055 (snapshot-exempt).
-- The drizzle-kit diff against the 0054 snapshot re-detects the column; suppressed here.
ALTER TABLE "video_jobs" ADD COLUMN "stylized_still_object_path" text;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "video_engine_id" varchar(64);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "image_engine_id" varchar(64);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "subtitle_engine_id" varchar(64);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "look_style_id" text;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "motion_preset_id" text;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "engine_mode" varchar(32);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "custom_mode_prompt" text;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "source_mode" varchar(32);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "options_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "stage1_cost_usd" numeric(10, 6);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "stage2_cost_usd" numeric(10, 6);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "stage3_cost_usd" numeric(10, 6);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "checkpoint_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "proceeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "motion_presets" ADD COLUMN "camera_motion" varchar(32);--> statement-breakpoint
ALTER TABLE "motion_presets" ADD COLUMN "motion_intensity" integer;--> statement-breakpoint
CREATE INDEX "IDX_engines_kind_active" ON "engines" USING btree ("kind","is_active");--> statement-breakpoint
CREATE INDEX "IDX_engines_kind_default" ON "engines" USING btree ("kind","is_default");--> statement-breakpoint
CREATE INDEX "IDX_memes_artifact_type" ON "memes" USING btree ("artifact_type");--> statement-breakpoint
CREATE INDEX "video_jobs_user_id_idx" ON "video_jobs" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "video_jobs" DROP COLUMN "style_id";