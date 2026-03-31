/**
 * One-shot script to backfill pgvector embeddings for all facts that don't have one.
 * Run with: pnpm --filter @workspace/api-server exec tsx ../../scripts/backfill-embeddings.ts
 */
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { isNull } from "drizzle-orm";
import { backfillEmbeddings } from "../artifacts/api-server/src/lib/embeddings";

const missing = await db
  .select({ id: factsTable.id })
  .from(factsTable)
  .where(isNull(factsTable.embedding));

console.log(`Starting backfill for ${missing.length} facts...`);

const result = await backfillEmbeddings((done, total) => {
  if (done % 5 === 0 || done === total) {
    console.log(`  ${done}/${total}`);
  }
});

console.log(`\nComplete! Processed: ${result.processed}, Failed: ${result.failed}`);
process.exit(0);
