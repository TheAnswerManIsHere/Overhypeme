/**
 * pgvector embedding utilities using OpenAI text-embedding-3-small (384 dims).
 * Requires OPENAI_API_KEY (a direct OpenAI key — the Replit proxy does not support /embeddings).
 */
import type OpenAI from "openai";
import { db, factsTable } from "@workspace/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { renderCanonical } from "./renderCanonical";
import { logger } from "./logger";
import { getEmbeddingsClient } from "./aiClients";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 384;

function getClient(): OpenAI {
  return getEmbeddingsClient();
}

/** Generate a 384-dim embedding for a piece of text. */
export async function embedText(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.trim(),
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

/** Persist an embedding (and optional canonical_text) for a fact row. */
export async function storeEmbedding(factId: number, embedding: number[], canonicalText?: string): Promise<void> {
  await db.update(factsTable)
    .set({ embedding, ...(canonicalText !== undefined ? { canonicalText } : {}) })
    .where(eq(factsTable.id, factId));
}

/**
 * Generate and persist the embedding for a fact after it is created.
 * If canonicalText is provided, embed that instead of the raw template text,
 * and persist it on the row.
 * Errors are logged but do not surface to the caller.
 */
export async function embedFactAsync(factId: number, text: string, canonicalText?: string): Promise<void> {
  try {
    if (process.env.TEST_SKIP_EMBEDDINGS === "1") {
      if (canonicalText !== undefined) {
        await db.update(factsTable)
          .set({ canonicalText })
          .where(eq(factsTable.id, factId));
      }
      return;
    }
    const textToEmbed = canonicalText ?? text;
    const embedding = await embedText(textToEmbed);
    await storeEmbedding(factId, embedding, canonicalText);
  } catch (err) {
    logger.error({ err, factId }, "[embeddings] Failed to embed fact");
  }
}

/**
 * Find the closest facts using pgvector cosine similarity.
 * Only considers rows that already have an embedding stored.
 * Returns results sorted by similarity descending, filtered to >= threshold.
 */
export async function findSimilarFacts(
  embedding: number[],
  { limit = 5, threshold = 0.85 }: { limit?: number; threshold?: number } = {},
): Promise<Array<{ id: number; text: string; canonicalText: string | null; similarity: number }>> {
  const vectorLiteral = `[${embedding.join(",")}]`;

  const rows = await db.execute(sql`
    SELECT
      id,
      text,
      canonical_text,
      1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM facts
    WHERE embedding IS NOT NULL AND is_active = true
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `);

  return (rows.rows as Array<{ id: number; text: string; canonical_text: string | null; similarity: number }>)
    .filter((r) => r.similarity >= threshold)
    .map((r) => ({
      id: Number(r.id),
      text: String(r.text),
      canonicalText: r.canonical_text ? String(r.canonical_text) : null,
      similarity: Number(r.similarity),
    }));
}

/** The most facts one fill run embeds, so a run's cost and time are bounded; the rest wait for the next run. */
export const FINGERPRINT_FILL_BATCH = 100;

/**
 * An approved fact (live or deactivated) without its duplicate fingerprint:
 * the embedding or the canonical text the duplicate check reads. The fill
 * below selects with it, and it is the "duplicate fingerprint missing"
 * needs-attention check (lib/factAttention.ts), so the two cannot differ.
 */
export const fingerprintMissingSql: SQL = sql`(${factsTable.approvedAt} IS NOT NULL AND (${factsTable.embedding} IS NULL OR ${factsTable.canonicalText} IS NULL))`;

/**
 * Fill the duplicate fingerprint of every fact `fingerprintMissingSql`
 * names, up to `limit` facts. Re-renders canonical_text from the template and
 * embeds from that. Runs a few minutes after a start and hourly (index.ts, the
 * `fingerprint_fill` task), so a missing fingerprint is filled automatically
 * (plan PLAN_FACT_LIFECYCLE_REBUILD.md 2C); `POST
 * /api/admin/facts/backfill-embeddings` runs it at once. `embed` is a test
 * seam.
 */
export async function backfillEmbeddings(opts: {
  onProgress?: (done: number, total: number) => void;
  limit?: number;
  embed?: (text: string) => Promise<number[]>;
  /** Test seam: fill only these facts, so a test's run cannot rewrite the
   *  plain-name version of another test's fact in a shared database. */
  onlyFactIds?: readonly number[];
} = {}): Promise<{ processed: number; failed: number }> {
  const { onProgress, limit = FINGERPRINT_FILL_BATCH, embed = embedText, onlyFactIds } = opts;
  const missing = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(onlyFactIds ? and(fingerprintMissingSql, inArray(factsTable.id, [...onlyFactIds])) : fingerprintMissingSql)
    .orderBy(factsTable.id)
    .limit(limit);

  let processed = 0;
  let failed = 0;

  for (const fact of missing) {
    try {
      const canonical = renderCanonical(fact.text);
      const embedding = await embed(canonical);
      await storeEmbedding(fact.id, embedding, canonical);
      processed++;
    } catch (err) {
      logger.error({ err, factId: fact.id }, "[embeddings] Backfill failed for fact");
      failed++;
    }
    onProgress?.(processed + failed, missing.length);
  }

  return { processed, failed };
}
