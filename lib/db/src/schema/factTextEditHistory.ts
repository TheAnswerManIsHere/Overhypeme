import {
  pgTable, bigserial, integer, varchar, text, timestamp, index,
} from "drizzle-orm/pg-core";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

/**
 * Audit history for the RARE, dire-warning-gated edit of an already-approved
 * fact's text (the "approved fact text lock" feature). One row per confirmed
 * protected text change — the never-approved staging edit path writes NO row
 * (that is normal authoring, not an exceptional mutation).
 *
 * The row is inserted in the SAME transaction as the `facts.text` mutation, so
 * an audit-insert failure rolls the edit back — the history and the mutation
 * commit or fail together. `oldText`/`newText` are the normalized STORED values
 * (from the locked row and the write, respectively), never the raw client
 * draft; `performedBy` is the authenticated admin, never trusted from the body.
 *
 * `performedBy` is nullable with `onDelete: "set null"` (mirroring
 * `enrichment_override_history`): the repo hard-deletes users, and the audit
 * history must survive an admin's account deletion rather than block it.
 *
 * See migration 0089.
 */
export const factTextEditHistoryTable = pgTable("fact_text_edit_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  /** Normalized stored text BEFORE the edit (from the locked fact row). */
  oldText: text("old_text").notNull(),
  /** Normalized stored text AFTER the edit (exactly what was written). */
  newText: text("new_text").notNull(),
  /** Why this exceptional edit was justified. Mandatory, trimmed, 10–2000 chars
   *  (enforced at the route/service boundary). */
  reason: text("reason").notNull(),
  /** The admin who performed the edit; null once that user is hard-deleted. */
  performedBy: varchar("performed_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The one query this table serves: fact-scoped, newest-first history for the
  // admin panel. A single compound index covers it (no redundant fact_id-only).
  index("IDX_fteh_fact_created").on(t.factId, t.createdAt.desc()),
]);

export type FactTextEditHistory = typeof factTextEditHistoryTable.$inferSelect;
export type InsertFactTextEditHistory = typeof factTextEditHistoryTable.$inferInsert;
