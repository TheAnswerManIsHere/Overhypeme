-- Launch Phase 8, increment 2a (plan docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md,
-- "Data Model and Migration Impact", items 2c and 3): the engine comparison's
-- sets, panels, cells, runs and reservations.
--
-- EXPAND, NOT CONTRACT: five new tables, nothing the previous release reads or
-- writes, so it keeps working unchanged. comparison_picks (blind judging) is
-- increment 3's. Row states: every table starts empty; nothing is backfilled.
-- Idempotent: every statement finds its own work done and skips it.
CREATE TABLE IF NOT EXISTS "comparison_sets" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "round" smallint NOT NULL,
  "fact_ids" jsonb NOT NULL,
  "scenario_keys" jsonb NOT NULL,
  "look_style_ids" jsonb NOT NULL,
  "engine_families" jsonb NOT NULL,
  "created_by" varchar,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comparison_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comparison_panels" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "set_id" bigint NOT NULL,
  "fact_id" integer NOT NULL,
  "scenario_key" varchar(40) NOT NULL,
  "look_style_id" varchar(64) NOT NULL,
  "image_mode" varchar(4) NOT NULL,
  "state" varchar(16) DEFAULT 'pending' NOT NULL,
  "skip_reason" text,
  "visual_plan" jsonb,
  "compiled_prompt" jsonb,
  "reference_identity_type" varchar(32),
  "reference_asset_version" varchar(32),
  "style_snapshot" jsonb,
  "render_controls" jsonb,
  "error" text,
  "shuffle_seed" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comparison_panels_set_id_comparison_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "comparison_sets"("id") ON DELETE cascade,
  CONSTRAINT "comparison_panels_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "facts"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comparison_panels_identity" ON "comparison_panels" ("set_id", "fact_id", "scenario_key", "look_style_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comparison_cells" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "panel_id" bigint NOT NULL,
  "engine_id" varchar(64) NOT NULL,
  "state" varchar(16) DEFAULT 'expected' NOT NULL,
  "skip_reason" text,
  "attempt_id" bigint,
  "rerun_count" smallint DEFAULT 0 NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comparison_cells_panel_id_comparison_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "comparison_panels"("id") ON DELETE cascade,
  CONSTRAINT "comparison_cells_attempt_id_image_prompt_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "image_prompt_attempts"("id") ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comparison_cells_panel_engine" ON "comparison_cells" ("panel_id", "engine_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comparison_runs" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "set_id" bigint NOT NULL,
  "kind" varchar(16) NOT NULL,
  "state" varchar(16) NOT NULL,
  "bound_usd" numeric(10, 4) NOT NULL,
  "allowance_usd" numeric(10, 4) NOT NULL,
  "week_remaining_usd" numeric(10, 4),
  "refusal" text,
  "created_by" varchar,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  CONSTRAINT "comparison_runs_set_id_comparison_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "comparison_sets"("id") ON DELETE cascade,
  CONSTRAINT "comparison_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_comparison_runs_set" ON "comparison_runs" ("set_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comparison_reservations" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "run_id" bigint NOT NULL,
  "kind" varchar(16) NOT NULL,
  "target" varchar(128) NOT NULL,
  "panel_id" bigint,
  "cell_id" bigint,
  "bound_usd" numeric(10, 4) NOT NULL,
  "settled_usd" numeric(10, 4),
  "state" varchar(16) DEFAULT 'reserved' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "comparison_reservations_run_id_comparison_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "comparison_runs"("id") ON DELETE cascade,
  CONSTRAINT "comparison_reservations_panel_id_comparison_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "comparison_panels"("id") ON DELETE set null,
  CONSTRAINT "comparison_reservations_cell_id_comparison_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "comparison_cells"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_comparison_reservations_state" ON "comparison_reservations" ("state", "created_at");
