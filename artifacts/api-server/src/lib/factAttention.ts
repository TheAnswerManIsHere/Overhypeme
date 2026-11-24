/**
 * @purpose The needs-attention checks: one SQL predicate per reason a fact needs an admin's look, shared by the Facts list's counts and its filter so the two cannot differ.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, section 2C and intent item
 * 17; the increment 2.2 outline on Issue #1018. Each predicate is a boolean
 * SQL expression over a row of `facts` (the outer query's `facts`), used both
 * in `count(*) FILTER (WHERE …)` and in a list's `WHERE`. Nothing here runs a
 * fix; the one automatic fix (the duplicate fingerprint) is
 * `backfillEmbeddings`, which selects with this file's predicate.
 *
 * Scopes: an approved fact is `approved_at IS NOT NULL` (live or
 * deactivated); a live fact is `is_active`. "Example missing" and "pictures
 * often failing" are a live fact's, as the plan words them.
 */
import { sql, type SQL } from "drizzle-orm";
import { factsTable } from "@workspace/db";
import { ATTENTION_REASONS, GAG_EXAMPLE_KINDS, IMAGE_PROMPT_GENERATION_VERSION, PROMPT_GENERATION_VERSION_KEY, attentionReasonOf, type AttentionReason } from "@workspace/api-zod";
import { IMAGE_ENGINE_IDS, PRE_ROUTING_IMAGE_ENGINE_IDS, fallbackEngineIdFor } from "./imageEngineRouting";
import { fingerprintMissingSql } from "./embeddings";

export { ATTENTION_REASONS, attentionReasonOf, type AttentionReason };

/**
 * "Pictures often failing": at least `ATTENTION_FAIL_MIN` of a live fact's
 * `ATTENTION_FAIL_WINDOW` most recent finished renders failed or were refused.
 * Set from data at 2.2 (Issue #1018, the 2.2 outline): production had no live
 * facts; on dev 3 of 117 finished renders failed (2.6%), at which rate a
 * healthy fact trips this about 0.2% of the time.
 */
export const ATTENTION_FAIL_WINDOW = 10;
export const ATTENTION_FAIL_MIN = 3;

/**
 * The generation a render compiled before the version was recorded, when the
 * render planner wrote it no plan: v11 removed the planner (PR #1022), so a
 * planless unrecorded render is v11 and a planned one is older. A constant,
 * not the current version: when v12 arrives, these renders are v11 and stale.
 */
export const UNRECORDED_PLANLESS_GENERATION = "v11";
/** What a planned unrecorded render reads as: any version before v11, never equal to a current one. */
const UNRECORDED_PLANNED_GENERATION = "pre-v11";

/** An approved fact, live or deactivated: the Facts page's facts (plan item 18). Every approved-only read uses this. */
export const approvedFact = sql`${factsTable.approvedAt} IS NOT NULL`;
const approved = approvedFact;
const live = sql`${factsTable.isActive}`;

/** Taxonomy missing: an approved fact with no stored taxonomy. A failed run never clears the column, so runs are not read. */
const taxonomyMissing = sql`(${approved} AND ${factsTable.enrichment} IS NULL)`;

const kindList = sql.join(GAG_EXAMPLE_KINDS.map((k) => sql`${k}`), sql`, `);

/** Example missing: a live fact with a published gag lacking a published example of some kind (only the gags carried over before example sets can be). */
const exampleMissing = sql`(${live} AND EXISTS (
  SELECT 1 FROM fact_gags g
  WHERE g.fact_id = ${factsTable.id} AND g.removed_at IS NULL AND g.approved_content IS NOT NULL
    AND (SELECT count(DISTINCT e.subject_kind) FROM fact_gag_examples e
         WHERE e.gag_id = g.id AND e.stage = 'approved' AND e.subject_kind IN (${kindList})) < ${GAG_EXAMPLE_KINDS.length}
))`;

/** A per-mode value for a render `a`: its mode is only i2i or t2i. */
const byMode = (i2i: string | null, t2i: string | null): SQL =>
  sql`CASE WHEN a.generation_mode = 'i2i' THEN ${i2i} ELSE ${t2i} END`;

const photoreal = IMAGE_ENGINE_IDS.photoreal;
/** The engine that drew a render: SQL's form of `attemptImageEngineId` (lib/imageEngineRouting.ts), the pre-0123 by-mode default for a null; retire both together. */
const drawnEngine = sql`COALESCE(a.actual_image_engine_id, ${byMode(PRE_ROUTING_IMAGE_ENGINE_IDS.i2i, PRE_ROUTING_IMAGE_ENGINE_IDS.t2i)})`;
const routedEngine = byMode(photoreal.i2i, photoreal.t2i);

/**
 * Whether a render (`a`, an `image_prompt_attempts` row) is current, from its
 * own recorded provenance only (not the content hash `isAttemptStale` reads
 * for the moderation grid):
 *  - its engine is the one routed today for its mode (moderation renders are
 *    photoreal), or the attempt records that today's routed engine refused it
 *    and it was redrawn on that engine's fallback (the record
 *    `switchedFallbackOf` reads, lib/engineFallback.ts);
 *  - its prompt generation is today's: the version its compiled prompt
 *    records, or, unrecorded, v11 without a planner plan and older with one.
 * COALESCE: a render with no fallback record makes the fallback clause NULL,
 * and NOT NULL would hide a stale render from the check.
 */
const renderIsCurrent = sql`COALESCE(
  (${drawnEngine} = ${routedEngine} OR (
    a.engine_fallback ->> 'state' = 'switched'
    AND a.engine_fallback ->> 'routedEngineId' = ${routedEngine}
    AND ${drawnEngine} = ${byMode(fallbackEngineIdFor(photoreal.i2i), fallbackEngineIdFor(photoreal.t2i))}
  ))
  AND COALESCE(a.compiled_prompt ->> ${PROMPT_GENERATION_VERSION_KEY},
    CASE WHEN a.visual_plan IS NOT NULL THEN ${UNRECORDED_PLANNED_GENERATION} ELSE ${UNRECORDED_PLANLESS_GENERATION} END)
    = ${IMAGE_PROMPT_GENERATION_VERSION},
  false)`;

/** Example stale: an approved fact with a published example on a kept gag whose render is not current. */
const exampleStale = sql`(${approved} AND EXISTS (
  SELECT 1 FROM fact_gags g
  JOIN fact_gag_examples e ON e.gag_id = g.id AND e.stage = 'approved'
  JOIN image_prompt_attempts a ON a.id = e.attempt_id
  WHERE g.fact_id = ${factsTable.id} AND g.removed_at IS NULL AND NOT ${renderIsCurrent}
))`;

/**
 * Pictures often failing: a live fact whose most recent finished renders,
 * member and admin alike (every render is an `image_prompt_attempts` row;
 * `user_ai_images` mirrors successes only), hold at least the minimum
 * failures. Finished is a picture or an error; a picture the photoreal
 * fallback drew is a success; eval-harness runs are left out.
 */
const picturesFailing = sql`(${live} AND (
  SELECT count(*) FILTER (WHERE r.failed) FROM (
    SELECT (a.generated_image_object_path IS NULL) AS failed
    FROM image_prompt_attempts a
    WHERE a.fact_id = ${factsTable.id} AND a.eval_run_id IS NULL
      AND (a.generated_image_object_path IS NOT NULL OR a.error IS NOT NULL)
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${ATTENTION_FAIL_WINDOW}
  ) r
) >= ${ATTENTION_FAIL_MIN})`;

/** Each reason's predicate over the outer query's `facts` row. */
export const ATTENTION_PREDICATES: Readonly<Record<AttentionReason, SQL>> = {
  taxonomy_missing: taxonomyMissing,
  example_stale: exampleStale,
  example_missing: exampleMissing,
  fingerprint_missing: fingerprintMissingSql,
  pictures_failing: picturesFailing,
};

/** One count per reason, over every fact: the same predicates the filter uses. */
export const ATTENTION_COUNT_COLUMNS = Object.fromEntries(
  ATTENTION_REASONS.map((r) => [r, sql<number>`count(*) FILTER (WHERE ${ATTENTION_PREDICATES[r]})`.mapWith(Number)]),
) as Record<AttentionReason, SQL<number>>;

/** A row's reasons, as an array of reason names (empty when it needs nothing). */
export const ATTENTION_REASONS_COLUMN = sql<AttentionReason[]>`array_remove(ARRAY[${sql.join(
  ATTENTION_REASONS.map((r) => sql`CASE WHEN ${ATTENTION_PREDICATES[r]} THEN ${r}::text END`),
  sql`, `,
)}], NULL)`;
