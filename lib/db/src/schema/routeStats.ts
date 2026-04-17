import { pgTable, varchar, integer, timestamp } from "drizzle-orm/pg-core";

export const routeStatsTable = pgTable("route_stats", {
  routeKey: varchar("route_key", { length: 50 }).primaryKey(),
  visitCount: integer("visit_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RouteStats = typeof routeStatsTable.$inferSelect;
