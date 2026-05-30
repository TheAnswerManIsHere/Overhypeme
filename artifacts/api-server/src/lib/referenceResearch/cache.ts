/**
 * Cache layer for the reference-research service.
 *
 * Cache key = sha256("<referenceType>\n<canonicalReference>\n<sourcePhrase>\n<factText>").
 * Including factText means the same canonical reference under different jokes
 * gets distinct visualImplication tuning (per David's pick); same fact +
 * same reference always returns the same cached result.
 *
 * In v1, no expires_at is set — entries live until manually purged. The
 * column exists in the schema so a TTL sweep is a one-line follow-up if
 * spend grows.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, referenceResearchCacheTable } from "@workspace/db";
import type {
  ReferenceResearchInput,
  ReferenceResearchResult,
} from "@workspace/api-zod";
import { logger } from "../logger";

export function computeReferenceResearchCacheKey(input: ReferenceResearchInput): string {
  const material = [
    input.referenceType,
    input.canonicalReference,
    input.sourcePhrase,
    input.factText,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

export async function getCachedResearchResult(
  cacheKey: string,
): Promise<ReferenceResearchResult | null> {
  try {
    const [row] = await db
      .select({
        result: referenceResearchCacheTable.result,
        expiresAt: referenceResearchCacheTable.expiresAt,
      })
      .from(referenceResearchCacheTable)
      .where(eq(referenceResearchCacheTable.cacheKey, cacheKey))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    return row.result as ReferenceResearchResult;
  } catch (err) {
    logger.warn({ err, cacheKey }, "[referenceResearch.cache] read failed (treating as miss)");
    return null;
  }
}

export async function setCachedResearchResult(
  cacheKey: string,
  input: ReferenceResearchInput,
  result: ReferenceResearchResult,
): Promise<void> {
  try {
    await db
      .insert(referenceResearchCacheTable)
      .values({
        cacheKey,
        input: input as unknown as Record<string, unknown>,
        result: result as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: referenceResearchCacheTable.cacheKey,
        set: {
          input: input as unknown as Record<string, unknown>,
          result: result as unknown as Record<string, unknown>,
          createdAt: new Date(),
          expiresAt: null,
        },
      });
  } catch (err) {
    logger.warn({ err, cacheKey }, "[referenceResearch.cache] write failed (non-fatal)");
  }
}
