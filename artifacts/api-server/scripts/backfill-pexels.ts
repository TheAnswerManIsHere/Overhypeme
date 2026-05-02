/**
 * Backfill Pexels images for all root facts that have NULL pexelsImages.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run backfill:pexels
 *
 * Runs sequentially with a 1-second delay between facts to respect Pexels rate limits.
 * Facts that already have images are skipped (idempotent).
 * Logs per-fact progress and a final summary to the console.
 *
 * Note: runFactImagePipeline suppresses all internal errors. Success is confirmed
 * by re-fetching pexelsImages from the DB after each call.
 */

// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { isNull, and, eq } from "drizzle-orm";
import { installStdioGuard } from "../src/lib/stdioGuard";
import { runFactImagePipeline } from "../src/lib/factImagePipeline";

// Task #402 / #404: absorb EIO/EPIPE on stdout/stderr so a torn-down pipe
// (e.g. workflow restart while this long-running backfill is mid-flight)
// does not crash the process. Must run before any console.* call.
installStdioGuard();

const DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("[backfill-pexels] Starting Pexels image backfill for root facts with NULL pexelsImages…");

  const facts = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(and(isNull(factsTable.parentId), isNull(factsTable.pexelsImages)));

  const total = facts.length;
  console.log(`[backfill-pexels] Found ${total} fact(s) to process.`);

  if (total === 0) {
    console.log("[backfill-pexels] Nothing to do. All root facts already have images.");
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i]!;
    console.log(`[backfill-pexels] [${i + 1}/${total}] fact ${fact.id}: "${fact.text.slice(0, 60)}"`);

    await runFactImagePipeline(fact.id, fact.text);

    // runFactImagePipeline catches all errors internally, so verify success via DB
    const [updated] = await db
      .select({ pexelsImages: factsTable.pexelsImages })
      .from(factsTable)
      .where(eq(factsTable.id, fact.id))
      .limit(1);

    if (updated?.pexelsImages != null) {
      succeeded++;
      console.log(`[backfill-pexels] [${i + 1}/${total}] fact ${fact.id} — OK`);
    } else {
      failed++;
      console.error(`[backfill-pexels] [${i + 1}/${total}] fact ${fact.id} — FAILED (pexelsImages still null after pipeline)`);
    }

    if (i < facts.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`[backfill-pexels] Done. ${succeeded} succeeded, ${failed} failed out of ${total} total.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-pexels] Fatal error:", err);
  process.exit(1);
});
