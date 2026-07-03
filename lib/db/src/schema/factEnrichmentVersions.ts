import {
  pgTable, bigserial, integer, varchar, text, jsonb, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { factsTable } from "./facts";
import { pendingReviewsTable } from "./reviews";
import { usersTable } from "./auth";

/**
 * Versioned enrichment archive + in-flight candidate store (stale-fact refresh).
 *
 * `facts.*` remains the SOLE active/runtime enrichment truth (Option B) — this
 * table never holds a `status='active'` mirror row, so existing Edit-Fact write
 * paths need no sync. It holds only:
 *   - `candidate`  — an in-flight refresh candidate (at most one per fact); the
 *                    candidate enrichment job writes its blob here, NOT to facts.*
 *   - `promoted`   — a candidate that was accepted and copied into facts.* (kept
 *                    as a point-in-time snapshot of what was promoted, and when)
 *   - `superseded` — a prior-active facts.* snapshot archived at a promotion
 *   - `rejected`   — a candidate reviewed but not promoted (retained history)
 *
 * `version_no` is a monotonic per-fact ARCHIVE counter (max+1 at insert time),
 * NOT a semantic active-lineage; the history UI sorts by `created_at`.
 * See migration 0078.
 */
export const factEnrichmentVersionsTable = pgTable("fact_enrichment_versions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factId: integer("fact_id").notNull().references(() => factsTable.id, { onDelete: "cascade" }),
  /** Monotonic per-fact archive counter (max+1 at insert). Archive order, not active lineage. */
  versionNo: integer("version_no").notNull(),
  /** candidate | promoted | superseded | rejected */
  status: varchar("status", { length: 16 }).notNull(),
  /** Materialized EFFECTIVE blob. Null on a freshly seeded candidate until its enrichment job completes. */
  enrichment: jsonb("enrichment"),
  /** Pure AI baseline for this version. */
  enrichmentAiDerived: jsonb("enrichment_ai_derived"),
  /** Path-keyed manual overrides carried by this version (seeded from active on send-back). */
  enrichmentOverrides: jsonb("enrichment_overrides").notNull().default({}),
  /**
   * Canonical manual visual-strategy override layer for this version. When
   * `enrichment` is non-null, `enrichment.visualPromptStrategyOverride` equals this.
   */
  visualOverride: jsonb("visual_override"),
  /** Hash of the RAW facts.text the candidate was classified against (promote drift guard). */
  factTextHash: text("fact_text_hash"),
  /** ProcessingSignature the candidate was generated under (stamped onto facts.last_processed_signature at promote). */
  signature: jsonb("signature"),
  /** refresh_candidate | prior_active_snapshot */
  source: varchar("source", { length: 24 }).notNull(),
  /** The review cycle that created this row (app-managed link; the review's candidate_version_id points back). */
  sourceReviewId: integer("source_review_id").references(() => pendingReviewsTable.id, { onDelete: "set null" }),
  note: text("note"),
  createdBy: varchar("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
}, (t) => [
  index("IDX_fev_fact_id").on(t.factId),
  index("IDX_fev_fact_status").on(t.factId, t.status),
  uniqueIndex("UQ_fev_fact_version_no").on(t.factId, t.versionNo),
  // At most one in-flight candidate per fact. MUST cover 'candidate' only —
  // historical rejected/superseded/promoted rows must never block a new refresh.
  uniqueIndex("UQ_fev_one_candidate_per_fact").on(t.factId).where(sql`${t.status} = 'candidate'`),
]);
