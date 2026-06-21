import {
  pgTable, bigserial, integer, varchar, text, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

/**
 * Audit history for manual taxonomy-enrichment overrides (the AI-derived vs
 * manual-override feature). One row per override mutation:
 *
 *   set       — a new override was created on a path.
 *   update    — an existing override's value changed.
 *   reset     — an override was deleted (field reverts to the AI baseline).
 *   auto_linked — an override created automatically to keep a cross-field
 *                 invariant valid (e.g. subtype forced by a primaryArchetype
 *                 override).
 *   baseline_reenriched — a path's AI baseline changed under a standing override
 *                 (written only on a not-changed → changed transition, never one
 *                 noisy row per unchanged override on every re-enrich).
 *
 * See migration 0072.
 */
export const enrichmentOverrideHistoryTable = pgTable("enrichment_override_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  /** The overridden path, e.g. "/primaryArchetype". */
  path: varchar("path", { length: 64 }).notNull(),
  /** set | update | reset | auto_linked | baseline_reenriched */
  action: varchar("action", { length: 24 }).notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  /** The AI generation id in effect at the time (for correlating with re-enrich). */
  aiGenerationId: varchar("ai_generation_id", { length: 64 }),
  reason: text("reason"),
  /** The admin who performed the action; null for system-driven rows. */
  performedBy: varchar("performed_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_eoh_fact_id").on(t.factId),
  index("IDX_eoh_created_at").on(t.createdAt.desc()),
]);

export type EnrichmentOverrideHistory = typeof enrichmentOverrideHistoryTable.$inferSelect;
export type InsertEnrichmentOverrideHistory = typeof enrichmentOverrideHistoryTable.$inferInsert;
