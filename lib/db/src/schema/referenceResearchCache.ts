import { pgTable, varchar, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Admin reference-research cache.
 *
 * Cache key is a SHA-256 hex of
 *   `${referenceType}\n${canonicalReference}\n${sourcePhrase}\n${factText}`
 * computed by the reference-research service. Same key → cached row → no
 * additional OpenAI call. `forceRefresh` body field on the route bypasses
 * the lookup and overwrites the row.
 *
 * See migration 0067.
 */
export const referenceResearchCacheTable = pgTable(
  "reference_research_cache",
  {
    cacheKey: varchar("cache_key", { length: 128 }).primaryKey(),
    input: jsonb("input").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("IDX_reference_research_cache_created_at").on(t.createdAt.desc())],
);

export type ReferenceResearchCacheRow = typeof referenceResearchCacheTable.$inferSelect;
export type InsertReferenceResearchCacheRow = typeof referenceResearchCacheTable.$inferInsert;
