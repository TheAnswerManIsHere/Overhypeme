import {
  pgTable, bigserial, integer, text, varchar, timestamp, index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * Append-only audit log for the manual "engine revision" marker (stale-fact
 * refresh). Bumping `admin_config.engine_revision` via the Taxonomy Health
 * "Mark major update" action writes one row here recording the transition and
 * who made it — so a corpus-wide staleness invalidation is always traceable to
 * an admin + reason. The `admin_config` row itself only holds the current
 * value; this table is the history.
 *
 * See migration 0080.
 */
export const engineRevisionBumpsTable = pgTable("engine_revision_bumps", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  oldRevision: integer("old_revision").notNull(),
  newRevision: integer("new_revision").notNull(),
  /** Optional admin-authored reason, e.g. "switched to the gpt-5.5 enricher". */
  note: text("note"),
  /** The admin who bumped it; null if that user is later removed. */
  performedBy: varchar("performed_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_erb_created_at").on(t.createdAt.desc()),
]);

export type EngineRevisionBump = typeof engineRevisionBumpsTable.$inferSelect;
export type InsertEngineRevisionBump = typeof engineRevisionBumpsTable.$inferInsert;
