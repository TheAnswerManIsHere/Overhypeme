import { pgTable, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const adminConfigTable = pgTable("admin_config", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  dataType: varchar("data_type", { length: 20 }).notNull().default("integer"),
  label: varchar("label", { length: 200 }).notNull(),
  description: text("description"),
  minValue: integer("min_value"),
  maxValue: integer("max_value"),
  /** If true, this value is returned by GET /api/config (no auth required). */
  isPublic: boolean("is_public").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedById: varchar("updated_by_id").references(() => usersTable.id, { onDelete: "set null" }),
});

export type AdminConfig = typeof adminConfigTable.$inferSelect;
