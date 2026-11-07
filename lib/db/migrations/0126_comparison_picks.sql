-- Launch Phase 8, increment 3: blind judging, and comparison runs without a
-- price limit. Expand only, on tables increment 2 created, which hold no
-- production rows (the comparison runs on dev).
--
-- comparison_picks: David's blind pick per panel, its face marks, and the
--   picks it replaced. One row per panel; cascades with the panel (and so
--   with the set) and with the picked cell.
-- comparison_runs.allowance_usd: no longer required. David, 2026-11-07:
--   "Ignore pricing entirely. Doesn't matter right now." A run since then
--   checks no allowance, so it records none (decisions.md).
CREATE TABLE IF NOT EXISTS "comparison_picks" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "panel_id" bigint NOT NULL,
  "picked_cell_id" bigint NOT NULL,
  "face_mismatch_cell_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "judged_by" varchar,
  "judged_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comparison_picks_panel_id_comparison_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "comparison_panels"("id") ON DELETE cascade,
  CONSTRAINT "comparison_picks_picked_cell_id_comparison_cells_id_fk" FOREIGN KEY ("picked_cell_id") REFERENCES "comparison_cells"("id") ON DELETE cascade,
  CONSTRAINT "comparison_picks_judged_by_users_id_fk" FOREIGN KEY ("judged_by") REFERENCES "users"("id") ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comparison_picks_panel" ON "comparison_picks" USING btree ("panel_id");--> statement-breakpoint
ALTER TABLE "comparison_runs" ALTER COLUMN "allowance_usd" DROP NOT NULL;
