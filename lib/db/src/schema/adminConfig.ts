import { pgTable, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const adminConfigTable = pgTable("admin_config", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  /** Human-friendly label for the current value (dropdown rows only). */
  valueLabel: text("value_label"),
  /** Alternate value used when debug mode is active. Null means fall through to the standard value. */
  debugValue: text("debug_value"),
  /** Human-friendly label for the debug value (dropdown rows only). */
  debugValueLabel: text("debug_value_label"),
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
