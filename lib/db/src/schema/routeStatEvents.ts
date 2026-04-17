import { pgTable, serial, varchar, integer, timestamp, index } from "drizzle-orm/pg-core";

export const routeStatEventsTable = pgTable("route_stat_events", {
  id: serial("id").primaryKey(),
  routeKey: varchar("route_key", { length: 50 }).notNull(),
  delta: integer("delta").notNull().default(1),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("route_stat_events_recorded_at_idx").on(table.recordedAt),
  index("route_stat_events_route_key_recorded_at_idx").on(table.routeKey, table.recordedAt),
]);

export type RouteStatEvent = typeof routeStatEventsTable.$inferSelect;
