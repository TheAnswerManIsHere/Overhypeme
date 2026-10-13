/**
 * The freshness predicates the legacy fixture preserves (plan D4, Astra LF2 /
 * C2): the readers' conclusions, not the stored hash bytes.
 *
 * Three readers compare a stored hash with one they compute from database
 * state at read time:
 *
 * - render staleness — `isAttemptStale` (factRenderScenarios.ts:192-194), the
 *   stored `review_render_input_hash` against `computeScenarioInputHash` over
 *   the review's cycle (reviewRenderScenarios.ts:119-148, 461-480);
 * - candidate promotion — the stored `fact_enrichment_versions.fact_text_hash`
 *   against `hashFactText(fact.text)` (enrichmentVersioning.ts:335);
 * - visual-concept freshness — `buildVisualConceptsResponse`
 *   (visualConceptJobs.ts:276-310), the blob's `reviewId`, `candidateVersionId`
 *   and `inputHash` against the review's live state.
 *
 * The "current" hash depends on what the database holds when the reader runs
 * (the cycle's text and enrichment, the configured concept engine and prompt),
 * so the outcome is recorded on the SOURCE by these readers and restored on the
 * LOADED database by the same readers, then re-checked; any row whose outcome
 * differs fails the load. Running the restoration where it can be measured
 * exactly is why it lives in the loader rather than the exporter.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { factEnrichmentVersionsTable, factsTable, imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";

import { hashFactText } from "../../lib/enrichmentVersioning";
import { computeScenarioInputHash, loadReviewRenderContext } from "../../lib/reviewRenderScenarios";
import { buildVisualConceptsResponse, computeCurrentInputHash, resolveVisualConceptCycle } from "../../lib/visualConceptJobs";
import type { RenderScenarioKey } from "@workspace/api-zod";

export type HashOutcome = "current" | "stale" | "no-context";

export interface PredicateRecord {
  /** image_prompt_attempts.id → outcome, for every review render with a stored hash. */
  renderAttempts: Record<string, HashOutcome>;
  /** fact_enrichment_versions.id → outcome, for every version with a stored text hash. */
  candidateTextHash: Record<string, HashOutcome>;
  /** pending_reviews.id → the concept reader's answer, for every review whose staging fact holds a blob. */
  conceptBlobs: Record<string, { current: boolean; staleReason: string | null }>;
}

export const emptyPredicateRecord = (): PredicateRecord => ({ renderAttempts: {}, candidateTextHash: {}, conceptBlobs: {} });

/** The render grid's current input hash for a review's scenario, its context loaded once per review. */
function renderHasher(): (reviewId: number, scenarioKey: string) => Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  const contexts = new Map<number, Awaited<ReturnType<typeof loadReviewRenderContext>>>();
  return async (reviewId, scenarioKey) => {
    if (!contexts.has(reviewId)) contexts.set(reviewId, await loadReviewRenderContext(reviewId));
    const loaded = contexts.get(reviewId)!;
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    return { ok: true, hash: computeScenarioInputHash(scenarioKey as RenderScenarioKey, loaded.ctx.stagingFactId, loaded.ctx.factText, loaded.ctx.enrichment) };
  };
}

/**
 * Evaluate the predicates against an exported snapshot (the export's own, plan D6; Codex round 1). The app
 * pool must hold exactly one connection (the export CLI sets DB_POOL_MAX=1 before the app loads): that
 * connection is put in a REPEATABLE READ READ ONLY transaction importing the snapshot, so every product
 * reader going through `db` sees it. Fails closed: a pool that is not single, a snapshot that will not
 * import, or a transaction that changed under the pass (a recycled connection) stops rather than records.
 */
export async function evaluatePredicatesInSnapshot(snapshotId: string, during?: () => Promise<void>): Promise<PredicateRecord> {
  const max = (pool as unknown as { options: { max?: number } }).options.max;
  if (max !== 1) throw new Error(`[legacy-fixture] the app pool holds ${max} connections; the snapshot binding needs exactly 1 (DB_POOL_MAX=1)`);
  const client = await pool.connect();
  let bound: string;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(`SET TRANSACTION SNAPSHOT '${snapshotId.replace(/'/g, "''")}'`);
    bound = (await client.query<{ t: string }>("SELECT now()::text AS t")).rows[0]!.t;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw new Error(`[legacy-fixture] the export's snapshot could not be bound: ${err instanceof Error ? err.message : String(err)}`);
  }
  client.release();
  try {
    if (during) await during();
    const record = await evaluatePredicates();
    const after = (await db.execute(sql`SELECT now()::text AS t, current_setting('transaction_isolation') AS iso`)).rows[0] as { t: string; iso: string };
    if (after.t !== bound || after.iso !== "repeatable read") {
      throw new Error("[legacy-fixture] the predicate pass left the export's snapshot (the pooled connection was recycled); re-run the export");
    }
    return record;
  } finally {
    const c = await pool.connect();
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

/** Evaluate every predicate against the database the app's `db` points at. */
export async function evaluatePredicates(): Promise<PredicateRecord> {
  const out = emptyPredicateRecord();

  // Render staleness, per attempt, against its review's cycle.
  const attempts = await db
    .select({
      id: imagePromptAttemptsTable.id,
      reviewId: imagePromptAttemptsTable.reviewId,
      scenarioKey: imagePromptAttemptsTable.reviewRenderScenarioKey,
      hash: imagePromptAttemptsTable.reviewRenderInputHash,
    })
    .from(imagePromptAttemptsTable)
    .where(and(isNotNull(imagePromptAttemptsTable.reviewId), isNotNull(imagePromptAttemptsTable.reviewRenderInputHash)));
  const currentHash = renderHasher();
  for (const a of attempts) {
    if (a.reviewId == null || a.scenarioKey == null) continue;
    const current = await currentHash(a.reviewId, a.scenarioKey);
    out.renderAttempts[String(a.id)] = !current.ok ? "no-context" : a.hash === current.hash ? "current" : "stale";
  }

  // Candidate text hash, per version, against its fact's text.
  const versions = await db
    .select({ id: factEnrichmentVersionsTable.id, hash: factEnrichmentVersionsTable.factTextHash, text: factsTable.text })
    .from(factEnrichmentVersionsTable)
    .innerJoin(factsTable, eq(factsTable.id, factEnrichmentVersionsTable.factId))
    .where(isNotNull(factEnrichmentVersionsTable.factTextHash));
  for (const v of versions) out.candidateTextHash[String(v.id)] = v.hash === hashFactText(v.text) ? "current" : "stale";

  // Concept freshness, per review, exactly as the review-detail route asks it (routes/reviews.ts:361-369).
  const reviews = await db
    .select({
      id: pendingReviewsTable.id,
      candidateVersionId: pendingReviewsTable.candidateVersionId,
      visualConceptStatus: factsTable.visualConceptStatus,
      visualConceptCandidates: factsTable.visualConceptCandidates,
    })
    .from(pendingReviewsTable)
    .innerJoin(factsTable, eq(factsTable.id, pendingReviewsTable.stagingFactId))
    .where(isNotNull(factsTable.visualConceptCandidates));
  for (const r of reviews) {
    const resp = await buildVisualConceptsResponse({
      id: r.id,
      candidateVersionId: r.candidateVersionId ?? null,
      visualConceptStatus: r.visualConceptStatus ?? null,
      visualConceptCandidates: r.visualConceptCandidates,
    });
    out.conceptBlobs[String(r.id)] = { current: resp.current, staleReason: (resp as { staleReason?: string }).staleReason ?? null };
  }
  return out;
}

/**
 * On the LOADED database: write the hash that makes each predicate answer as
 * recorded. A row recorded "current" gets the hash the reader computes now; a
 * row recorded "stale" keeps the exporter's re-keyed value, which no reader
 * computes. Returns the rows it could not restore.
 */
export async function restorePredicates(expected: PredicateRecord): Promise<string[]> {
  const problems: string[] = [];

  const currentHash = renderHasher();
  for (const [id, outcome] of Object.entries(expected.renderAttempts)) {
    if (outcome !== "current") continue;
    const [a] = await db
      .select({ reviewId: imagePromptAttemptsTable.reviewId, scenarioKey: imagePromptAttemptsTable.reviewRenderScenarioKey })
      .from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.id, Number(id)));
    if (!a || a.reviewId == null || a.scenarioKey == null) {
      problems.push(`render attempt ${id}: missing from the load`);
      continue;
    }
    const current = await currentHash(a.reviewId, a.scenarioKey);
    if (!current.ok) {
      problems.push(`render attempt ${id}: its review has no render context on the fixture (${current.reason})`);
      continue;
    }
    await db.update(imagePromptAttemptsTable).set({ reviewRenderInputHash: current.hash }).where(eq(imagePromptAttemptsTable.id, Number(id)));
  }

  for (const [id, outcome] of Object.entries(expected.candidateTextHash)) {
    if (outcome !== "current") continue;
    const [v] = await db
      .select({ text: factsTable.text })
      .from(factEnrichmentVersionsTable)
      .innerJoin(factsTable, eq(factsTable.id, factEnrichmentVersionsTable.factId))
      .where(eq(factEnrichmentVersionsTable.id, Number(id)));
    if (!v) {
      problems.push(`enrichment version ${id}: missing from the load`);
      continue;
    }
    await db.update(factEnrichmentVersionsTable).set({ factTextHash: hashFactText(v.text) }).where(eq(factEnrichmentVersionsTable.id, Number(id)));
  }

  for (const [reviewId, outcome] of Object.entries(expected.conceptBlobs)) {
    if (!outcome.current) continue;
    const resolved = await resolveVisualConceptCycle(Number(reviewId));
    if (!resolved.ok) {
      problems.push(`review ${reviewId}: its concept cycle does not resolve on the fixture`);
      continue;
    }
    const inputHash = await computeCurrentInputHash(resolved.cycle);
    const [r] = await db.select({ stagingFactId: pendingReviewsTable.stagingFactId }).from(pendingReviewsTable).where(eq(pendingReviewsTable.id, Number(reviewId)));
    if (!r?.stagingFactId) {
      problems.push(`review ${reviewId}: no staging fact on the fixture`);
      continue;
    }
    const [f] = await db.select({ blob: factsTable.visualConceptCandidates }).from(factsTable).where(eq(factsTable.id, r.stagingFactId));
    const blob = { ...(f?.blob as Record<string, unknown>), inputHash };
    await db.update(factsTable).set({ visualConceptCandidates: blob }).where(eq(factsTable.id, r.stagingFactId));
  }
  return problems;
}

/** Every row whose outcome on the loaded database differs from the source's. */
export function comparePredicates(expected: PredicateRecord, actual: PredicateRecord): string[] {
  const diffs: string[] = [];
  const cmp = <T>(label: string, a: Record<string, T>, b: Record<string, T>, eqf: (x: T, y: T) => boolean) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) diffs.push(`${label} ${k}: recorded on the source, absent on the fixture`);
      else if (!(k in a)) diffs.push(`${label} ${k}: present on the fixture, not recorded on the source`);
      else if (!eqf(a[k]!, b[k]!)) diffs.push(`${label} ${k}: ${JSON.stringify(a[k])} on the source, ${JSON.stringify(b[k])} on the fixture`);
    }
  };
  cmp("render attempt", expected.renderAttempts, actual.renderAttempts, (x, y) => x === y);
  cmp("enrichment version", expected.candidateTextHash, actual.candidateTextHash, (x, y) => x === y);
  cmp("concept blob of review", expected.conceptBlobs, actual.conceptBlobs, (x, y) => x.current === y.current && x.staleReason === y.staleReason);
  return diffs;
}

/** Counts per outcome, for the manifest and the readers test. */
export function predicateCounts(r: PredicateRecord): Record<string, Record<string, number>> {
  const tally = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  return {
    renderAttempts: tally(Object.values(r.renderAttempts)),
    candidateTextHash: tally(Object.values(r.candidateTextHash)),
    conceptBlobs: tally(Object.values(r.conceptBlobs).map((c) => (c.current ? "current" : `stale:${c.staleReason}`))),
  };
}
