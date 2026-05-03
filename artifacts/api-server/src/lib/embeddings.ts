/**
 * pgvector embedding utilities using OpenAI text-embedding-3-small (384 dims).
 * Requires OPENAI_API_KEY (a direct OpenAI key — the Replit proxy does not support /embeddings).
 */
import OpenAI from "openai";
import { db, factsTable } from "@workspace/db";
import { eq, isNull, sql, and } from "drizzle-orm";
import { renderCanonical } from "./renderCanonical";
import { logger } from "./logger";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 384;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
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

/**
 * Backfill embeddings for every fact that lacks either an embedding or a canonical_text.
 * Re-renders canonical_text from the template and embeds from that.
 * Call POST /api/admin/facts/backfill-embeddings to trigger this.
 */
export async function backfillEmbeddings(
  onProgress?: (done: number, total: number) => void,
): Promise<{ processed: number; failed: number }> {
  const missing = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(and(
      eq(factsTable.isActive, true),
      sql`(${factsTable.embedding} IS NULL OR ${factsTable.canonicalText} IS NULL)`,
    ));

  let processed = 0;
  let failed = 0;

  for (const fact of missing) {
    try {
      const canonical = renderCanonical(fact.text);
      const embedding = await embedText(canonical);
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
