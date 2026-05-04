import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  reactionsTable,
  factsTable,
  memesTable,
  commentsTable,
  type ReactionTargetType,
  type ReactionType,
} from "@workspace/db/schema";

function computeWilsonScore(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes;
  if (n === 0) return 0;
  const z = 1.96;
  const pHat = upvotes / n;
  const numerator = pHat + (z * z) / (2 * n) - z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;
  return numerator / denominator;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Recompute and persist the precomputed aggregate fields on the target row
 * from the current contents of `reactions`. Runs inside the caller's tx so
 * counts stay consistent with the reaction write that triggered them.
 */
async function refreshTargetCounts(tx: Tx, targetType: ReactionTargetType, targetId: number): Promise<void> {
  if (targetType === "fact") {
    const [{ upvotes, downvotes }] = await tx
      .select({
        upvotes: sql<number>`count(*) filter (where ${reactionsTable.reactionType} = 'up')::int`,
        downvotes: sql<number>`count(*) filter (where ${reactionsTable.reactionType} = 'down')::int`,
      })
      .from(reactionsTable)
      .where(and(eq(reactionsTable.targetType, "fact"), eq(reactionsTable.targetId, targetId)));
    const wilsonScore = computeWilsonScore(upvotes, downvotes);
    await tx
      .update(factsTable)
      .set({ upvotes, downvotes, score: upvotes - downvotes, wilsonScore })
      .where(eq(factsTable.id, targetId));
    return;
  }
  if (targetType === "meme") {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(reactionsTable)
      .where(and(eq(reactionsTable.targetType, "meme"), eq(reactionsTable.targetId, targetId), eq(reactionsTable.reactionType, "heart")));
    await tx.update(memesTable).set({ heartCount: count }).where(eq(memesTable.id, targetId));
    return;
  }
  if (targetType === "comment") {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(reactionsTable)
      .where(and(eq(reactionsTable.targetType, "comment"), eq(reactionsTable.targetId, targetId), eq(reactionsTable.reactionType, "heart")));
    await tx.update(commentsTable).set({ heartCount: count }).where(eq(commentsTable.id, targetId));
    return;
  }
}

/**
 * Set a user's fact rating to one of "up" / "down" / "none". For "up" or
 * "down", removes any opposing rating from the same user before inserting
 * the new one. Recomputes the fact's denormalised vote counts and Wilson
 * score from the resulting reactions state.
 */
export async function setFactRating(
  userId: string,
  factId: number,
  rating: "up" | "down" | "none",
): Promise<{ upvotes: number; downvotes: number; userRating: "up" | "down" | null }> {
  return db.transaction(async (tx) => {
    if (rating === "none") {
      await tx
        .delete(reactionsTable)
        .where(and(
          eq(reactionsTable.userId, userId),
          eq(reactionsTable.targetType, "fact"),
          eq(reactionsTable.targetId, factId),
        ));
    } else {
      const opposing = rating === "up" ? "down" : "up";
      await tx
        .delete(reactionsTable)
        .where(and(
          eq(reactionsTable.userId, userId),
          eq(reactionsTable.targetType, "fact"),
          eq(reactionsTable.targetId, factId),
          eq(reactionsTable.reactionType, opposing),
        ));
      await tx
        .insert(reactionsTable)
        .values({ userId, targetType: "fact", targetId: factId, reactionType: rating })
        .onConflictDoNothing();
    }

    await refreshTargetCounts(tx, "fact", factId);

    const [updated] = await tx
      .select({ upvotes: factsTable.upvotes, downvotes: factsTable.downvotes })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .limit(1);

    const [current] = await tx
      .select({ reactionType: reactionsTable.reactionType })
      .from(reactionsTable)
      .where(and(
        eq(reactionsTable.userId, userId),
        eq(reactionsTable.targetType, "fact"),
        eq(reactionsTable.targetId, factId),
      ))
      .limit(1);

    const userRating = (current?.reactionType as "up" | "down" | undefined) ?? null;
    return { upvotes: updated.upvotes, downvotes: updated.downvotes, userRating };
  });
}

/**
 * Toggle a heart reaction by `userId` on the given target. Returns the new
 * `heart_count` and whether the viewer is now hearting it.
 */
export async function toggleHeart(
  userId: string,
  targetType: Extract<ReactionTargetType, "meme" | "comment">,
  targetId: number,
): Promise<{ heartCount: number; viewerHasHearted: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: reactionsTable.id })
      .from(reactionsTable)
      .where(and(
        eq(reactionsTable.userId, userId),
        eq(reactionsTable.targetType, targetType),
        eq(reactionsTable.targetId, targetId),
        eq(reactionsTable.reactionType, "heart"),
      ))
      .limit(1);

    let viewerHasHearted: boolean;
    if (existing) {
      await tx.delete(reactionsTable).where(eq(reactionsTable.id, existing.id));
      viewerHasHearted = false;
    } else {
      await tx
        .insert(reactionsTable)
        .values({ userId, targetType, targetId, reactionType: "heart" })
        .onConflictDoNothing();
      viewerHasHearted = true;
    }

    await refreshTargetCounts(tx, targetType, targetId);

    if (targetType === "meme") {
      const [{ heartCount }] = await tx
        .select({ heartCount: memesTable.heartCount })
        .from(memesTable)
        .where(eq(memesTable.id, targetId))
        .limit(1);
      return { heartCount, viewerHasHearted };
    }
    const [{ heartCount }] = await tx
      .select({ heartCount: commentsTable.heartCount })
      .from(commentsTable)
      .where(eq(commentsTable.id, targetId))
      .limit(1);
    return { heartCount, viewerHasHearted };
  });
}

/**
 * Bulk lookup: which of the given `targetIds` (of `targetType`) does the
 * user currently react to with the given `reactionType`? Returns the set of
 * matching ids. Used to populate `viewerHasHearted` / `userRating` in list
 * responses without N+1 queries.
 */
export async function getViewerReactionTargetIds(
  userId: string,
  targetType: ReactionTargetType,
  reactionType: ReactionType,
  targetIds: number[],
): Promise<Set<number>> {
  if (!targetIds.length) return new Set();
  const rows = await db
    .select({ targetId: reactionsTable.targetId })
    .from(reactionsTable)
    .where(and(
      eq(reactionsTable.userId, userId),
      eq(reactionsTable.targetType, targetType),
      eq(reactionsTable.reactionType, reactionType),
      inArray(reactionsTable.targetId, targetIds),
    ));
  return new Set(rows.map((r) => r.targetId));
}

/**
 * Bulk lookup: returns a map of factId → "up" | "down" for the given user.
 * Mirrors the legacy `ratings` semantics where each user has at most one
 * vote (up XOR down) per fact.
 */
export async function getViewerFactRatings(
  userId: string,
  factIds: number[],
): Promise<Map<number, "up" | "down">> {
  const map = new Map<number, "up" | "down">();
  if (!factIds.length) return map;
  const rows = await db
    .select({ factId: reactionsTable.targetId, reactionType: reactionsTable.reactionType })
    .from(reactionsTable)
    .where(and(
      eq(reactionsTable.userId, userId),
      eq(reactionsTable.targetType, "fact"),
      inArray(reactionsTable.targetId, factIds),
      inArray(reactionsTable.reactionType, ["up", "down"]),
    ));
  for (const r of rows) map.set(r.factId, r.reactionType as "up" | "down");
  return map;
}
