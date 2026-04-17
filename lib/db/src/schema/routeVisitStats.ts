import { pgTable, varchar, bigint, timestamp } from "drizzle-orm/pg-core";

export const routeVisitStatsTable = pgTable("route_visit_stats", {
  routeKey: varchar("route_key", { length: 50 }).primaryKey(),
  visitCount: bigint("visit_count", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RouteVisitStat = typeof routeVisitStatsTable.$inferSelect;
