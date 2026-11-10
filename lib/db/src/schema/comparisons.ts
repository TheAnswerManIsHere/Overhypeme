import {
  pgTable, bigserial, bigint, integer, smallint, varchar, text, jsonb, numeric, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";
import { imagePromptAttemptsTable } from "./imagePromptAttempts";

/**
 * Launch Phase 8 — the engine comparison (plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C and D,
 * *Data Model* items 2c and 3; migration 0124).
 *
 * A SET names its facts, scenarios, styles and engine families. A PANEL is one
 * fact × scenario × style, prepared once (planner + compiler) and frozen, so
 * every engine renders the same compiled prompt. A CELL is panel × engine. A
 * RUN is one batch of paid work (preparing panels or rendering cells); its
 * RESERVATIONS are the record of each call it made — its worst-case cost and
 * its fal request id. Since David's override of 2026-11-07 no allowance gates
 * a run (`decisions.md`). A PICK is David's blind choice for one panel
 * (increment 3; migration 0126).
 */

export const comparisonSetsTable = pgTable("comparison_sets", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  label: text("label").notNull(),
  /** 1, 2 or 3 (the plan's rounds). */
  round: smallint("round").notNull(),
  /** number[] — the facts David named. */
  factIds: jsonb("fact_ids").notNull(),
  /** RenderScenarioKey[] */
  scenarioKeys: jsonb("scenario_keys").notNull(),
  /** string[] — look style ids; "none" for no style. */
  lookStyleIds: jsonb("look_style_ids").notNull(),
  /** string[] — engine families (engines.family), each a text-to-image + edit pair. */
  engineFamilies: jsonb("engine_families").notNull(),
  createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const comparisonPanelsTable = pgTable("comparison_panels", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  setId: bigint("set_id", { mode: "number" }).notNull().references(() => comparisonSetsTable.id, { onDelete: "cascade" }),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  scenarioKey: varchar("scenario_key", { length: 40 }).notNull(),
  /** "none" for no style. */
  lookStyleId: varchar("look_style_id", { length: 64 }).notNull(),
  /** "t2i" | "i2i", from the scenario. */
  imageMode: varchar("image_mode", { length: 4 }).notNull(),
  /** "pending" | "preparing" | "prepared" | "failed" | "skipped" */
  state: varchar("state", { length: 16 }).notNull().default("pending"),
  skipReason: text("skip_reason"),
  /** Frozen at preparation (increment 2b): the planner output and the compiled prompt every cell renders. */
  visualPlan: jsonb("visual_plan"),
  compiledPrompt: jsonb("compiled_prompt"),
  referenceIdentityType: varchar("reference_identity_type", { length: 32 }),
  referenceAssetVersion: varchar("reference_asset_version", { length: 32 }),
  /** The resized default reference every edit cell of this panel receives (2b). */
  referenceImageUrl: text("reference_image_url"),
  styleSnapshot: jsonb("style_snapshot"),
  renderControls: jsonb("render_controls"),
  error: text("error"),
  /** Seeds the blind view's stable shuffle (increment 3). */
  shuffleSeed: integer("shuffle_seed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("UQ_comparison_panels_identity").on(t.setId, t.factId, t.scenarioKey, t.lookStyleId),
]);

export const comparisonCellsTable = pgTable("comparison_cells", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  panelId: bigint("panel_id", { mode: "number" }).notNull().references(() => comparisonPanelsTable.id, { onDelete: "cascade" }),
  /** The engine of the set's family whose mode is the panel's. */
  engineId: varchar("engine_id", { length: 64 }).notNull(),
  /** "expected" | "enqueued" | "rendered" | "failed" | "skipped" */
  state: varchar("state", { length: 16 }).notNull().default("expected"),
  skipReason: text("skip_reason"),
  attemptId: bigint("attempt_id", { mode: "number" }).references(() => imagePromptAttemptsTable.id, { onDelete: "set null" }),
  /** Manual re-runs taken (the plan allows one per cell, through admission). */
  rerunCount: smallint("rerun_count").notNull().default(0),
  error: text("error"),
  /** The one fal submission this cell's attempt made; stored before polling so a resume never resubmits. */
  falRequestId: varchar("fal_request_id", { length: 128 }),
  /** The vendor's image URL, kept so a storage failure retries without buying a second image. */
  vendorResultUrl: text("vendor_result_url"),
  /** Where the rendered image is stored. */
  imageObjectPath: text("image_object_path"),
  /** The endpoint settings this cell sent. */
  requestSettings: jsonb("request_settings"),
  /** When this cell's request was sent to fal (migration 0128). */
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  /** When fal returned the image; minus `submittedAt`, the wait a caller sees (fal's queue plus drawing). */
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("UQ_comparison_cells_panel_engine").on(t.panelId, t.engineId),
]);

export const comparisonRunsTable = pgTable("comparison_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  setId: bigint("set_id", { mode: "number" }).notNull().references(() => comparisonSetsTable.id, { onDelete: "cascade" }),
  /** "prepare" | "render" */
  kind: varchar("kind", { length: 16 }).notNull(),
  /** "admitted" | "refused" | "running" | "done" | "failed" */
  state: varchar("state", { length: 16 }).notNull(),
  /** Sum of the run's reservations at admission. */
  boundUsd: numeric("bound_usd", { precision: 10, scale: 4 }).notNull(),
  /** The per-run allowance admission checked against; null since the 2026-11-07 override (no allowance). */
  allowanceUsd: numeric("allowance_usd", { precision: 10, scale: 4 }),
  /** The week's remaining paid-run budget the operator supplied; null since the 2026-11-07 override. */
  weekRemainingUsd: numeric("week_remaining_usd", { precision: 10, scale: 4 }),
  /** Why admission refused, with the figure. */
  refusal: text("refusal"),
  createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [index("IDX_comparison_runs_set").on(t.setId, t.createdAt)]);

export const comparisonReservationsTable = pgTable("comparison_reservations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: bigint("run_id", { mode: "number" }).notNull().references(() => comparisonRunsTable.id, { onDelete: "cascade" }),
  /** "planner" | "image" */
  kind: varchar("kind", { length: 16 }).notNull(),
  /** The model or engine id the call goes to. */
  target: varchar("target", { length: 128 }).notNull(),
  panelId: bigint("panel_id", { mode: "number" }).references(() => comparisonPanelsTable.id, { onDelete: "set null" }),
  cellId: bigint("cell_id", { mode: "number" }).references(() => comparisonCellsTable.id, { onDelete: "set null" }),
  /**
   * The fal request this reservation paid for, written with the cell's at
   * submission. A re-run replaces the cell's id; this one never changes, so
   * each reservation settles only from its own call's bill.
   */
  falRequestId: varchar("fal_request_id", { length: 128 }),
  /** The worst-case cost held until billing settles it. */
  boundUsd: numeric("bound_usd", { precision: 10, scale: 4 }).notNull(),
  /** The real billed amount once established (never clipped to the bound). */
  settledUsd: numeric("settled_usd", { precision: 10, scale: 4 }),
  /** "reserved" | "settled" | "released" — a reserved row counts at its bound. */
  state: varchar("state", { length: 16 }).notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [index("IDX_comparison_reservations_state").on(t.state, t.createdAt)]);

/**
 * David's blind judgement of one panel (plan, *Proposed Design* E): a score of
 * 1 to 5 for every image the panel showed (David, 2026-11-10, in place of a
 * single "best" pick; migration 0127). One row per panel; a re-judgement
 * replaces the scores and moves the previous ones into `history`. Face marks
 * name cells whose face is not the person (human reference panels only).
 */
export const comparisonPicksTable = pgTable("comparison_picks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  panelId: bigint("panel_id", { mode: "number" }).notNull().references(() => comparisonPanelsTable.id, { onDelete: "cascade" }),
  /** The single-pick judging's "best" cell; written null since judging rates every image. */
  pickedCellId: bigint("picked_cell_id", { mode: "number" }).references(() => comparisonCellsTable.id, { onDelete: "cascade" }),
  /** { cellId: number; score: 1..5 }[] — one per image the panel showed. */
  ratings: jsonb("ratings").notNull().default([]),
  /** number[] — cells of this panel marked "not the person". */
  faceMismatchCellIds: jsonb("face_mismatch_cell_ids").notNull().default([]),
  /** Previous judgements, oldest first: { ratings, faceMismatchCellIds, judgedBy, judgedAt }[]. */
  history: jsonb("history").notNull().default([]),
  judgedBy: varchar("judged_by").references(() => usersTable.id, { onDelete: "set null" }),
  judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("UQ_comparison_picks_panel").on(t.panelId),
]);

export type ComparisonSet = typeof comparisonSetsTable.$inferSelect;
export type ComparisonPanel = typeof comparisonPanelsTable.$inferSelect;
export type ComparisonCell = typeof comparisonCellsTable.$inferSelect;
export type ComparisonRun = typeof comparisonRunsTable.$inferSelect;
export type ComparisonReservation = typeof comparisonReservationsTable.$inferSelect;
export type ComparisonPick = typeof comparisonPicksTable.$inferSelect;
