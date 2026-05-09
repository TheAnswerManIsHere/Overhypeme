import { pgTable, text, integer, varchar, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { factsTable } from "./facts";
import { usersTable } from "./auth";

/**
 * Phase 4 audit table: tracks every call to the transient render endpoints
 * (`/api/render-preview`, `/api/render-download`). Persists no rendered bytes
 * — only metadata for abuse detection and per-user analytics. Rolled by a
 * scheduled purger after `transient_renders.retention_days` (default 30).
 *
 * IPs are stored as `sha256(ip || server_salt)` so the table can be queried by
 * source-IP without retaining raw addresses (matches the Phase-1 audit-PII
 * principle).
 */
export const transientRendersTable = pgTable("transient_renders", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** "preview" or "download" — distinguishes the two endpoints. */
  endpoint: varchar("endpoint", { length: 16 }).notNull(),
  /** FK → facts.id; nullable when the request was rejected before fact lookup. */
  factId: integer("fact_id").references(() => factsTable.id, { onDelete: "set null" }),
  /** FK → users.id; null for anonymous callers. */
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** sha256 hex of (raw IP || server-side salt). Never store raw IPs. */
  ipHash: text("ip_hash").notNull(),
  /** "stock" | "self-upload" | "pulid"; null when the request was rejected before mode resolution. */
  mode: varchar("mode", { length: 24 }),
  /** "success" | "rejected" | "error". */
  result: varchar("result", { length: 12 }).notNull(),
  /** Free-form reason populated when result='rejected'. */
  rejectionReason: text("rejection_reason"),
  /** End-to-end latency in ms; null for rows logged before the response was sent. */
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_transient_renders_ip_hash_created_at").on(table.ipHash, table.createdAt),
  index("idx_transient_renders_user_id_created_at").on(table.userId, table.createdAt),
  index("idx_transient_renders_created_at").on(table.createdAt),
]);

export type TransientRender = typeof transientRendersTable.$inferSelect;
export type InsertTransientRender = typeof transientRendersTable.$inferInsert;
