/**
 * Backfill AI meme backgrounds for all active facts that don't have them yet.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run backfill:ai-memes
 *
 * - Processes facts one at a time (rate-limited by OpenAI calls)
 * - Skips facts that already have aiMemeImages
 * - Adds a 5-second delay between facts to avoid OpenAI rate limits
 * - Logs progress to stdout
 */

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { generateAiMemeBackgrounds } from "../src/lib/aiMemePipeline";
import type { AiMemeImages } from "../src/lib/aiMemePipeline";

const DELAY_BETWEEN_FACTS_MS = 8000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("[backfill] Fetching all active facts without AI meme images...");

  const facts = await db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      canonicalText: factsTable.canonicalText,
      aiMemeImages: factsTable.aiMemeImages,
    })
    .from(factsTable)
    .where(eq(factsTable.isActive, true));

  const toProcess = facts.filter(f => {
    const images = f.aiMemeImages as AiMemeImages | null;
    if (!images) return true;
    const totalImages = (images.male ?? []).filter(Boolean).length +
      (images.female ?? []).filter(Boolean).length +
      (images.neutral ?? []).filter(Boolean).length;
    return totalImages < 9;
  });

  console.log(`[backfill] ${facts.length} total facts, ${toProcess.length} need AI meme generation`);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const fact = toProcess[i]!;
    const factText = fact.canonicalText ?? fact.text ?? "";

    if (!factText.trim()) {
      console.log(`[backfill] Skipping fact ${fact.id} — no text`);
      continue;
    }

    console.log(`[backfill] [${i + 1}/${toProcess.length}] Processing fact ${fact.id}: "${factText.slice(0, 60)}..."`);

    try {
      await generateAiMemeBackgrounds(fact.id, factText);
      succeeded++;
      console.log(`[backfill] fact ${fact.id} done`);
    } catch (err) {
      failed++;
      console.error(`[backfill] fact ${fact.id} failed:`, err);
    }

    if (i < toProcess.length - 1) {
      console.log(`[backfill] Waiting ${DELAY_BETWEEN_FACTS_MS / 1000}s before next fact...`);
      await sleep(DELAY_BETWEEN_FACTS_MS);
    }
  }

  console.log(`[backfill] Complete: ${succeeded} succeeded, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
