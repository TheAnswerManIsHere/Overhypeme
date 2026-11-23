import { sql } from "drizzle-orm";
import {
  pgTable, bigserial, bigint, integer, varchar, text, jsonb, timestamp, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { factsTable } from "./facts";

/**
 * A fact's AI taxonomy run history (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 16
 * and 2B; Issue #1018, increment 2.1b). One row per classifier call, failures
 * included, written by runEnrichmentForFact in the transaction that stores (or
 * declines to store) its result. Migration 0159 converted the legacy
 * fact_enrichment_versions rows into `legacy_*` rows, and 0160 added each
 * fact's taxonomy as it stood (`legacy_current`) before dropping that table. Rows are never updated by
 * the app; they go with their fact.
 *
 *   outcome  ok        — the output was stored as the fact's taxonomy
 *            failed    — the call threw; `error` says why; no output
 *            discarded — the call returned but the fact changed while it ran,
 *                        so the output was kept here and not stored
 *   origin   provisional_approval | rerun | unrecorded (a job queued before
 *            2.1b) | legacy_promoted | legacy_superseded (0159, from a legacy
 *            enrichment version) | legacy_current (0160, the taxonomy a fact
 *            held when the legacy tables were dropped)
 */
export const FACT_TAXONOMY_RUN_OUTCOMES = ["ok", "failed", "discarded"] as const;
export const FACT_TAXONOMY_RUN_ORIGINS = [
  "provisional_approval", "rerun", "unrecorded", "legacy_promoted", "legacy_superseded", "legacy_current",
] as const;
export type FactTaxonomyRunOutcome = (typeof FACT_TAXONOMY_RUN_OUTCOMES)[number];
export type FactTaxonomyRunOrigin = (typeof FACT_TAXONOMY_RUN_ORIGINS)[number];

export const factTaxonomyRunsTable = pgTable("fact_taxonomy_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  outcome: varchar("outcome", { length: 16 }).$type<FactTaxonomyRunOutcome>().notNull(),
  origin: varchar("origin", { length: 24 }).$type<FactTaxonomyRunOrigin>().notNull(),
  /** The classifier's output (ok, discarded); null on a failed call. */
  output: jsonb("output"),
  /** Why the call failed, or why its output was discarded. */
  error: text("error"),
  /** The admin who asked for a Re-run; null otherwise. */
  requestedBy: varchar("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  /** The legacy fact_enrichment_versions row this was converted from (0159; the table was dropped by 0160). */
  legacyVersionId: bigint("legacy_version_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fact_taxonomy_runs_fact_idx").on(t.factId, t.createdAt),
  uniqueIndex("fact_taxonomy_runs_legacy_version_uq").on(t.legacyVersionId),
  check("fact_taxonomy_runs_outcome_valid", sql`${t.outcome} IN ('ok', 'failed', 'discarded')`),
  check(
    "fact_taxonomy_runs_origin_valid",
    sql`${t.origin} IN ('provisional_approval', 'rerun', 'unrecorded', 'legacy_promoted', 'legacy_superseded', 'legacy_current')`,
  ),
  check("fact_taxonomy_runs_output_matches_outcome", sql`(${t.outcome} = 'failed') = (${t.output} IS NULL)`),
  check(
    "fact_taxonomy_runs_legacy_marked",
    sql`(${t.legacyVersionId} IS NOT NULL) = (${t.origin} IN ('legacy_promoted', 'legacy_superseded'))`,
  ),
]);

export type FactTaxonomyRunRow = typeof factTaxonomyRunsTable.$inferSelect;
