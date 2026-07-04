import { pgTable, bigserial, text, jsonb, varchar, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * Eval harness (Slice 2B) — one controlled batch render of the golden set.
 *
 * A "run" renders every golden fact under the CURRENT pipeline, so two runs can
 * be diffed to tell whether a pipeline change moved quality. The broad pipeline
 * profile (planner engine/model/effort, imagePromptGenerationVersion,
 * scenario-config version, archetype strategy version) is captured ONCE here in
 * `run_profile`; the per-render signature (scenario, subjectRenderMode, actual
 * image engine, reference identity/version, look style) lives on each
 * `image_prompt_attempts` row so a run can span multiple scenarios/engines.
 *
 * See migration 0080 + lib/eval/*.
 */
export const evalRunsTable = pgTable("eval_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Optional human label ("baseline", "gpt-5.5 xhigh", "post-compiler-fix"). */
  label: text("label"),
  /** Broad pipeline profile captured once at run creation (EvalRunProfile). */
  runProfile: jsonb("run_profile"),
  createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EvalRun = typeof evalRunsTable.$inferSelect;
export type InsertEvalRun = typeof evalRunsTable.$inferInsert;
