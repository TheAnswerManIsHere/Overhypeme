/**
 * One-time scrub: remove the personalized SUBJECT (the canonical placeholder
 * name "Alex" / residual identity tokens) from stored `enrichment.semanticEntities`
 * on already-saved `facts` and `pending_reviews` rows.
 *
 * The subject's identity belongs to the personalization/rendering layer, not to
 * semantic entities. Newly enriched facts are kept clean at enrichment time;
 * this fixes rows enriched before that guard shipped so the admin editor and the
 * image-prompt pipeline stop surfacing the subject as a referent.
 *
 * Usage (Replit owns the DB — run against your own database):
 *   # dry run (default): reports what WOULD change, writes nothing
 *   pnpm --filter @workspace/api-server run cleanup:subject-name-entities
 *   # apply the changes
 *   pnpm --filter @workspace/api-server run cleanup:subject-name-entities -- --apply
 *
 * Idempotent: a second run finds nothing to change. Surgical — it only replaces
 * the `semanticEntities` array on each blob, leaving every other field intact.
 */

// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { eq, isNotNull } from "drizzle-orm";
import { stripSubjectNameSemanticEntities } from "../src/lib/renderCanonical";

/** Minimal shape we touch — leave every other enrichment field untouched. */
interface EnrichmentLike {
  semanticEntities?: Array<{ surfaceText: string; normalizedText: string }>;
  [key: string]: unknown;
}

const APPLY = process.argv.includes("--apply");

interface TableStats {
  table: string;
  scanned: number;
  changed: number;
  entitiesRemoved: number;
}

async function scrubFacts(): Promise<TableStats> {
  const rows = await db
    .select({ id: factsTable.id, enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(isNotNull(factsTable.enrichment));

  const stats: TableStats = { table: "facts", scanned: rows.length, changed: 0, entitiesRemoved: 0 };

  for (const row of rows) {
    const enr = row.enrichment as EnrichmentLike | null;
    const entities = enr?.semanticEntities ?? [];
    if (entities.length === 0) continue;

    const kept = stripSubjectNameSemanticEntities(entities);
    const removed = entities.length - kept.length;
    if (removed === 0) continue;

    stats.changed += 1;
    stats.entitiesRemoved += removed;
    const dropped = entities.filter((e) => !kept.includes(e)).map((e) => e.surfaceText);
    console.log(`[cleanup] fact ${row.id}: removing ${removed} subject entit${removed === 1 ? "y" : "ies"} [${dropped.join(", ")}]`);

    if (APPLY) {
      await db
        .update(factsTable)
        .set({ enrichment: { ...(enr as object), semanticEntities: kept } as typeof row.enrichment })
        .where(eq(factsTable.id, row.id));
    }
  }
  return stats;
}

async function scrubPendingReviews(): Promise<TableStats> {
  const rows = await db
    .select({ id: pendingReviewsTable.id, enrichment: pendingReviewsTable.enrichment })
    .from(pendingReviewsTable)
    .where(isNotNull(pendingReviewsTable.enrichment));

  const stats: TableStats = { table: "pending_reviews", scanned: rows.length, changed: 0, entitiesRemoved: 0 };

  for (const row of rows) {
    const enr = row.enrichment as EnrichmentLike | null;
    const entities = enr?.semanticEntities ?? [];
    if (entities.length === 0) continue;

    const kept = stripSubjectNameSemanticEntities(entities);
    const removed = entities.length - kept.length;
    if (removed === 0) continue;

    stats.changed += 1;
    stats.entitiesRemoved += removed;
    const dropped = entities.filter((e) => !kept.includes(e)).map((e) => e.surfaceText);
    console.log(`[cleanup] pending_review ${row.id}: removing ${removed} subject entit${removed === 1 ? "y" : "ies"} [${dropped.join(", ")}]`);

    if (APPLY) {
      await db
        .update(pendingReviewsTable)
        .set({ enrichment: { ...(enr as object), semanticEntities: kept } as typeof row.enrichment })
        .where(eq(pendingReviewsTable.id, row.id));
    }
  }
  return stats;
}

async function main(): Promise<void> {
  console.log(`[cleanup] Subject-name semantic-entity scrub — mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);

  const results = [await scrubFacts(), await scrubPendingReviews()];

  console.log("\n[cleanup] Summary:");
  let totalChanged = 0;
  let totalRemoved = 0;
  for (const r of results) {
    console.log(`  ${r.table}: scanned ${r.scanned}, rows changed ${r.changed}, entities removed ${r.entitiesRemoved}`);
    totalChanged += r.changed;
    totalRemoved += r.entitiesRemoved;
  }
  console.log(`  TOTAL: rows changed ${totalChanged}, entities removed ${totalRemoved}`);
  if (!APPLY && totalChanged > 0) {
    console.log("\n[cleanup] Dry run only — re-run with `-- --apply` to write these changes.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[cleanup] failed:", err);
  process.exit(1);
});
