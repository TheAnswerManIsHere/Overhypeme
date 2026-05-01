import { index, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const rateLimitCountersTable = pgTable("rate_limit_counters", {
  keyHash: varchar("key_hash", { length: 64 }).primaryKey(),
  keyRaw: text("key_raw").notNull(),
  count: integer("count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_rate_limit_counters_expires_at").on(table.expiresAt),
]);
