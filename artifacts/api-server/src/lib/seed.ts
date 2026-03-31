import { db } from "@workspace/db";
import { factsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { SEED_FACTS } from "../data/seed-facts";
import { embedFactAsync } from "./embeddings";

export async function seedIfEmpty(): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(factsTable);

  if (count > 0) {
    return;
  }

  console.log("[seed] Production database is empty — seeding", SEED_FACTS.length, "facts...");

  for (const item of SEED_FACTS) {
    const [fact] = await db
      .insert(factsTable)
      .values({ text: item.text })
      .returning({ id: factsTable.id });

    for (const tagName of item.hashtags) {
      const existing = await db
        .select({ id: hashtagsTable.id })
        .from(hashtagsTable)
        .where(eq(hashtagsTable.name, tagName))
        .limit(1);

      let tagId: number;
      if (existing.length > 0) {
        tagId = existing[0].id;
      } else {
        const [newTag] = await db
          .insert(hashtagsTable)
          .values({ name: tagName })
          .returning({ id: hashtagsTable.id });
        tagId = newTag.id;
      }

      await db
        .insert(factHashtagsTable)
        .values({ factId: fact.id, hashtagId: tagId })
        .onConflictDoNothing();
    }

    embedFactAsync(fact.id, item.text).catch(() => {});
  }

  console.log("[seed] Done seeding facts.");
}
