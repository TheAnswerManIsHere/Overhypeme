/**
 * pgvector embedding utilities.
 *
 * Embedding generation requires either:
 *   OPENAI_API_KEY  – direct OpenAI API key (not the Replit proxy, which doesn't support /embeddings)
 *
 * When no key is available, embedText() throws and callers silently skip embedding storage.
 * The pgvector column and IVFFlat index are kept in place so embeddings can be populated
 * later (via backfill) once a key is configured.
 */
import OpenAI from "openai";
import { db, factsTable } from "@workspace/db";
import { eq, isNull, sql } from "drizzle-orm";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 384;

function getEmbeddingClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Embeddings are disabled. " +
      "Set OPENAI_API_KEY (a direct OpenAI key) to enable vector duplicate detection.",
    );
  }
  return new OpenAI({ apiKey });
}

/**
 * Generate a 384-dimensional embedding for a piece of text.
 * Requires OPENAI_API_KEY (direct, not Replit proxy).
 * Throws when the key is absent — callers should catch and skip.
 */
export async function embedText(text: string): Promise<number[]> {
  const client = getEmbeddingClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.trim(),
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

/**
 * Store an embedding for an existing fact row.
 */
export async function storeEmbedding(factId: number, embedding: number[]): Promise<void> {
  await db
    .update(factsTable)
    .set({ embedding })
    .where(eq(factsTable.id, factId));
}

/**
 * Generate and persist the embedding for a fact — fails silently when no API key is set.
 */
export async function embedFactAsync(factId: number, text: string): Promise<void> {
  try {
    const embedding = await embedText(text);
    await storeEmbedding(factId, embedding);
  } catch (err) {
    // Silently skip when no embedding API is configured
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("OPENAI_API_KEY")) {
      console.error(`[embeddings] Failed to embed fact ${factId}:`, err);
    }
  }
}

/**
 * Returns true when an embedding API key is configured.
 */
export function isEmbeddingEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Find the closest facts to a given embedding using pgvector cosine similarity.
 * Returns results with similarity scores in [0, 1] — higher means more similar.
 */
export async function findSimilarFacts(
  embedding: number[],
  { limit = 5, threshold = 0.85 }: { limit?: number; threshold?: number } = {},
): Promise<Array<{ id: number; text: string; similarity: number }>> {
  const vectorLiteral = `[${embedding.join(",")}]`;

  const rows = await db.execute(sql`
    SELECT
      id,
      text,
      1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM facts
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `);

  return (rows.rows as Array<{ id: number; text: string; similarity: number }>)
    .filter((r) => r.similarity >= threshold)
    .map((r) => ({
      id: Number(r.id),
      text: String(r.text),
      similarity: Number(r.similarity),
    }));
}

/**
 * Backfill embeddings for all facts that don't have one yet.
 * Requires OPENAI_API_KEY.
 */
export async function backfillEmbeddings(
  onProgress?: (done: number, total: number) => void,
): Promise<{ processed: number; failed: number; skipped?: number }> {
  if (!isEmbeddingEnabled()) {
    return { processed: 0, failed: 0, skipped: -1 };
  }

  const missing = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(isNull(factsTable.embedding));

  let processed = 0;
  let failed = 0;

  for (const fact of missing) {
    try {
      const embedding = await embedText(fact.text);
      await storeEmbedding(fact.id, embedding);
      processed++;
    } catch (err) {
      console.error(`[embeddings] Backfill failed for fact ${fact.id}:`, err);
      failed++;
    }
    onProgress?.(processed + failed, missing.length);
  }

  return { processed, failed };
}
