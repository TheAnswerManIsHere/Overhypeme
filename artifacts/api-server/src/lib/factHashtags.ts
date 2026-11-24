/**
 * @purpose Attach and detach a fact's hashtags, keeping each hashtag's fact count: the one writer of `fact_hashtags`, for approval and for the fact sheet.
 * @subsystem moderation
 *
 * Production approval attaches the final tags (routes/reviews.ts); the fact
 * sheet replaces them (lib/factSheet.ts, plan PLAN_FACT_LIFECYCLE_REBUILD.md
 * item 20). Callers pass sanitized tags (lib/hashtags.ts); attach
 * re-sanitizes so its input can never drift from the canonical rule.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { factHashtagsTable, hashtagsTable } from "@workspace/db/schema";
import { sanitizeHashtagsForPersistence } from "./hashtags";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The most hashtags a fact keeps: the cap at approval and on the fact sheet. */
export const FACT_HASHTAG_LIMIT = 50;

/** Attach tags to a fact, creating each hashtag as needed; a tag already attached is left as it is. */
export async function attachHashtags(tx: Executor, factId: number, tags: readonly string[]): Promise<void> {
  for (const name of sanitizeHashtagsForPersistence(tags, { limit: FACT_HASHTAG_LIMIT })) {
    let [ht] = await tx.select().from(hashtagsTable).where(eq(hashtagsTable.name, name)).limit(1);
    if (!ht) { [ht] = await tx.insert(hashtagsTable).values({ name }).returning(); }
    const [joined] = await tx.insert(factHashtagsTable).values({ factId, hashtagId: ht!.id }).onConflictDoNothing().returning();
    if (joined) {
      await tx.update(hashtagsTable).set({ factCount: sql`${hashtagsTable.factCount} + 1` }).where(eq(hashtagsTable.id, ht!.id));
    }
  }
}

/** Detach hashtags from a fact by id, lowering each one's fact count once per join row actually removed. */
export async function detachHashtags(tx: Executor, factId: number, hashtagIds: readonly number[]): Promise<void> {
  if (hashtagIds.length === 0) return;
  const gone = await tx.delete(factHashtagsTable)
    .where(and(eq(factHashtagsTable.factId, factId), inArray(factHashtagsTable.hashtagId, [...hashtagIds])))
    .returning({ id: factHashtagsTable.hashtagId });
  if (gone.length === 0) return;
  await tx.update(hashtagsTable)
    .set({ factCount: sql`GREATEST(${hashtagsTable.factCount} - 1, 0)` })
    .where(inArray(hashtagsTable.id, gone.map((g) => g.id)));
}

/** A fact's hashtags, alphabetical. */
export async function factHashtagNames(factId: number, executor: Executor = db): Promise<string[]> {
  const rows = await executor
    .select({ name: hashtagsTable.name })
    .from(factHashtagsTable)
    .innerJoin(hashtagsTable, eq(hashtagsTable.id, factHashtagsTable.hashtagId))
    .where(eq(factHashtagsTable.factId, factId))
    .orderBy(hashtagsTable.name);
  return rows.map((r) => r.name);
}
