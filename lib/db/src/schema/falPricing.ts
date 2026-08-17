import { pgTable, text, numeric, timestamp, serial, index, boolean } from "drizzle-orm/pg-core";

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
  /**
   * Cost provenance, and deliberately NULLABLE with no default.
   *
   *   false -> derived from fal's published rate for that endpoint
   *   true  -> derived from an operator-configured estimate or a hard-coded
   *            fallback
   *   NULL  -> unrecoverable for this historical row, or written by a build
   *            predating the flag
   *
   * NOT measured-vs-estimated: no row in this table holds an actual provider
   * charge. `getCachedPrice` returns an hourly-refreshed unit rate and
   * `costComputation.ts` derives a cost from dimensions, count and duration
   * without ever reading a billing result. Both values are computed — one
   * tracks fal, the other tracks our own guess.
   *
   * `NOT NULL DEFAULT false` was rejected: it would assert "provider-resolved"
   * for every pre-existing row, including the videoPipelineRunner stage rows
   * known to be estimates. Recording an unknown as a known is the failure this
   * column exists to prevent.
   *
   * When true, `pricing_fetched_at` on that row is the WRITE time, not a fetch
   * time. See docs/plans/is-estimated-cost-ledger.md.
   */
  isEstimated: boolean("is_estimated"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("user_gen_costs_user_created_idx").on(table.userId, table.createdAt),
]);

export type UserGenerationCost = typeof userGenerationCostsTable.$inferSelect;
export type InsertUserGenerationCost = typeof userGenerationCostsTable.$inferInsert;
