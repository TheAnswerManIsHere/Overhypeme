/**
 * Backfill AI meme backgrounds for all active facts that don't have them yet.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run backfill:ai-memes
 *
 * Enqueues one `fact_ai_meme_backfill` job per active fact missing full image
 * coverage, then polls each job to a terminal state before exiting. The API
 * server's async-jobs worker must be running for enqueued jobs to actually
 * process — this script only schedules the work; it does not call
 * OpenAI/fal.ai itself. Idempotent: re-running dedupes onto any still-in-flight
 * job for a fact rather than double-enqueueing (and paying for it twice).
 */

// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { AiMemeImages } from "../src/lib/aiMemePipeline";
import { enqueueFactAiMemeBackfill } from "../src/lib/aiMemeBackfillJobs";
import { pollJobsToTerminal, type PollableJob } from "../src/lib/cliJobPoller";

async function main(): Promise<void> {
  console.log("[backfill-ai-memes] Fetching all active facts without full AI meme image coverage...");

  const facts = await db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      aiMemeImages: factsTable.aiMemeImages,
    })
    .from(factsTable)
    .where(eq(factsTable.isActive, true));

  const toProcess = facts.filter((f) => {
    const images = f.aiMemeImages as AiMemeImages | null;
    if (!images) return true;
    const totalImages =
      (images.male ?? []).filter(Boolean).length +
      (images.female ?? []).filter(Boolean).length +
      (images.neutral ?? []).filter(Boolean).length;
    return totalImages < 9;
  });

  console.log(`[backfill-ai-memes] ${facts.length} total facts, ${toProcess.length} need AI meme generation`);

  if (toProcess.length === 0) {
    console.log("[backfill-ai-memes] Nothing to do.");
    process.exit(0);
  }

  const jobs: PollableJob[] = [];
  for (const fact of toProcess) {
    const result = await enqueueFactAiMemeBackfill(fact.id);
    jobs.push({ jobId: result.jobId, label: fact.text.slice(0, 60) });
  }
  console.log(`[backfill-ai-memes] Enqueued ${jobs.length} job(s) — waiting for the async-jobs worker to drain them…`);

  const { succeeded, skipped, failed, unresolved } = await pollJobsToTerminal(jobs, {
    log: (msg) => console.log(`[backfill-ai-memes] ${msg}`),
  });

  console.log(
    `[backfill-ai-memes] Done. ${succeeded} succeeded, ${skipped} skipped, ${failed} failed, ${unresolved.length} unresolved out of ${toProcess.length} total.`,
  );
  process.exit(failed > 0 || unresolved.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-ai-memes] Fatal error:", err);
  process.exit(1);
});
