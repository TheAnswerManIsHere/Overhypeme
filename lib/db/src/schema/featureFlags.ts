import { pgTable, varchar, boolean, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const featureFlagsTable = pgTable("feature_flags", {
  key: varchar("key", { length: 100 }).primaryKey(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  description: varchar("description", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FeatureFlag = typeof featureFlagsTable.$inferSelect;
export type InsertFeatureFlag = typeof featureFlagsTable.$inferInsert;

export const tierFeaturePermissionsTable = pgTable("tier_feature_permissions", {
  tier: varchar("tier", { length: 50 }).notNull(),
  featureKey: varchar("feature_key", { length: 100 }).notNull().references(() => featureFlagsTable.key, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.tier, t.featureKey] }),
}));

export type TierFeaturePermission = typeof tierFeaturePermissionsTable.$inferSelect;
export type InsertTierFeaturePermission = typeof tierFeaturePermissionsTable.$inferInsert;
