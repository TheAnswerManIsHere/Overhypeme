/**
 * Backfill `split_token_index` for all facts rows where the column is NULL.
 *
 * Run with:
 *   npx tsx src/scripts/backfill-split-token-index.ts
 *
 * The script processes rows in batches of 100 and logs progress. After all
 * rows are updated it queries the table once more to confirm 0 NULLs remain.
 */
import { eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { computeSplitTokenIndex } from "../lib/splitTokenIndex";
import { logger } from "../lib/logger";

const BATCH_SIZE = 100;

async function run() {
  logger.info("Starting splitTokenIndex backfill…");
  let totalProcessed = 0;

  while (true) {
    const batch = await db
      .select({ id: factsTable.id, text: factsTable.text })
      .from(factsTable)
      .where(isNull(factsTable.splitTokenIndex))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const fact of batch) {
      const idx = computeSplitTokenIndex(fact.text);
      await db
        .update(factsTable)
        .set({ splitTokenIndex: idx })
        .where(eq(factsTable.id, fact.id));
    }

    totalProcessed += batch.length;
    logger.info({ totalProcessed }, "  processed rows so far…");
  }

  logger.info({ totalProcessed }, "Done — updated facts.");

  // Verification: confirm no NULLs remain.
  const remaining = await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(isNull(factsTable.splitTokenIndex))
    .limit(1);

  if (remaining.length === 0) {
    logger.info("Verified: 0 facts with null split_token_index.");
  } else {
    logger.warn("Some facts still have null split_token_index — check for errors above.");
    process.exit(1);
  }
}

run().catch((err) => {
  logger.error({ err }, "Backfill failed");
  process.exit(1);
});
