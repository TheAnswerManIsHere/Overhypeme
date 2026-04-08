import { pgTable, text, numeric, timestamp, serial, index } from "drizzle-orm/pg-core";

export const falPricingCacheTable = pgTable("fal_pricing_cache", {
  endpointId: text("endpoint_id").primaryKey(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 6 }).notNull(),
  unit: text("unit").notNull(),
  currency: text("currency").notNull().default("USD"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FalPricingCache = typeof falPricingCacheTable.$inferSelect;

export const userGenerationCostsTable = pgTable("user_generation_costs", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  jobType: text("job_type").notNull(),
  endpointId: text("endpoint_id").notNull(),
  unitPriceAtCreation: numeric("unit_price_at_creation", { precision: 12, scale: 6 }).notNull(),
  billingUnits: numeric("billing_units", { precision: 12, scale: 4 }).notNull(),
  computedCostUsd: numeric("computed_cost_usd", { precision: 10, scale: 4 }).notNull(),
  pricingFetchedAt: timestamp("pricing_fetched_at", { withTimezone: true }).notNull(),
  jobReferenceId: text("job_reference_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("user_gen_costs_user_created_idx").on(table.userId, table.createdAt),
]);

export type UserGenerationCost = typeof userGenerationCostsTable.$inferSelect;
export type InsertUserGenerationCost = typeof userGenerationCostsTable.$inferInsert;
