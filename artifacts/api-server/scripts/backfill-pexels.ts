/**
 * Backfill Pexels images for all active facts (root or variant) that have
 * NULL pexelsImages.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run backfill:pexels
 *
 * Enqueues one `fact_pexels` job per fact and polls each to a terminal state
 * before exiting — the API server's async-jobs worker must be running for
 * enqueued jobs to actually process (this script only schedules the work; it
 * does not call OpenAI/Pexels itself). Idempotent: facts that already have
 * images are skipped by the selection query, and re-running dedupes onto any
 * still-in-flight job for a fact rather than double-enqueueing.
 */

// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { isNull, and, eq } from "drizzle-orm";
import { enqueueFactPexels } from "../src/lib/factPexelsJobs";
import { pollJobsToTerminal, type PollableJob } from "../src/lib/cliJobPoller";

async function main(): Promise<void> {
  console.log("[backfill-pexels] Starting Pexels image backfill for active facts with NULL pexelsImages…");

  const facts = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(and(eq(factsTable.isActive, true), isNull(factsTable.pexelsImages)));

  const total = facts.length;
  console.log(`[backfill-pexels] Found ${total} fact(s) to process.`);

  if (total === 0) {
    console.log("[backfill-pexels] Nothing to do. All active facts already have images.");
    process.exit(0);
  }

  const jobs: PollableJob[] = [];
  for (const fact of facts) {
    const result = await enqueueFactPexels(fact.id, { bulkBackfill: true });
    jobs.push({ jobId: result.jobId, label: fact.text.slice(0, 60) });
  }
  console.log(`[backfill-pexels] Enqueued ${jobs.length} job(s) — waiting for the async-jobs worker to drain them…`);

  const { succeeded, skipped, failed, unresolved } = await pollJobsToTerminal(jobs, {
    log: (msg) => console.log(`[backfill-pexels] ${msg}`),
  });

  console.log(`[backfill-pexels] Done. ${succeeded} succeeded, ${skipped} skipped, ${failed} failed, ${unresolved.length} unresolved out of ${total} total.`);
  process.exit(failed > 0 || unresolved.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-pexels] Fatal error:", err);
  process.exit(1);
});
