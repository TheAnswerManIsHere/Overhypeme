import { db } from "@workspace/db";
import { factsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { count, eq, sql } from "drizzle-orm";

const FACTS = [
  "{NAME} {doesn't|don't} read books. {Subj} stares them down until {SUBJ} gets the information {SUBJ} wants.",
  "{NAME} can sneeze with {POSS} eyes open.",
  "{NAME} counted to infinity — twice.",
  "{NAME} can divide by zero.",
  "When {NAME} enters a room, {SUBJ} {doesn't|don't} turn the lights on. {Subj} turns the dark off.",
  "{NAME} once kicked a horse in the chin. Its descendants are now known as giraffes.",
  "{NAME} {doesn't|don't} wear a watch. {Subj} decides what time it is.",
  "{NAME} can hear sign language.",
  "{NAME} {has|have} a grizzly bear carpet in {POSS} room. The bear isn't dead, it's just afraid to move.",
  "{NAME} once threw a grenade and killed 50 people — then it exploded.",
  "{NAME} can win a game of Connect Four in only three moves.",
  "Death once had a near-{NAME} experience.",
  "{NAME} can set ants on fire with a magnifying glass. At night.",
  "When {NAME} {does|do} a pushup, {SUBJ} {isn't|aren't} lifting {REFL} up. {Subj}'s pushing the Earth down.",
  "{NAME} once parallel parked a train.",
];

const HASHTAGS = [
  "strength",
  "wisdom",
  "mathematics",
  "physics",
  "animals",
  "time",
  "senses",
  "death",
  "games",
  "explosions",
  "nature",
  "vehicles",
  "fitness",
  "supernatural",
];

const FACT_HASHTAG_MAP: Record<number, string[]> = {
  0: ["wisdom", "strength"],
  1: ["supernatural", "senses"],
  2: ["mathematics", "supernatural"],
  3: ["mathematics", "physics"],
  4: ["supernatural", "physics"],
  5: ["animals", "strength"],
  6: ["time", "wisdom"],
  7: ["senses", "supernatural"],
  8: ["animals", "strength"],
  9: ["explosions", "strength"],
  10: ["games", "wisdom"],
  11: ["death", "supernatural"],
  12: ["nature", "physics"],
  13: ["fitness", "strength", "physics"],
  14: ["vehicles", "strength"],
};

async function seed() {
  const [{ value: existing }] = await db
    .select({ value: count() })
    .from(factsTable);

  if (existing > 0) {
    console.log(`Seed skipped — ${existing} facts already exist.`);
    process.exit(0);
  }

  console.log("Seeding database…");

  const insertedHashtags = await db
    .insert(hashtagsTable)
    .values(HASHTAGS.map((name) => ({ name })))
    .onConflictDoNothing()
    .returning();

  const hashtagMap = new Map<string, number>(
    insertedHashtags.map((h: { name: string; id: number }) => [h.name, h.id]),
  );

  const insertedFacts = await db
    .insert(factsTable)
    .values(
      FACTS.map((text) => {
        const upvotes = Math.floor(Math.random() * 200);
        const downvotes = Math.floor(Math.random() * 20);
        return { text, upvotes, downvotes, score: upvotes - downvotes };
      }),
    )
    .returning();

  for (const [factIdx, tags] of Object.entries(FACT_HASHTAG_MAP)) {
    const fact = insertedFacts[Number(factIdx)];
    if (!fact) continue;
    for (const tag of tags) {
      const hashtagId = hashtagMap.get(tag);
      if (hashtagId === undefined) continue;
      await db
        .insert(factHashtagsTable)
        .values({ factId: fact.id, hashtagId })
        .onConflictDoNothing();
    }
  }

  const joinCounts = await db
    .select({ hashtagId: factHashtagsTable.hashtagId, cnt: sql<number>`count(*)::int` })
    .from(factHashtagsTable)
    .groupBy(factHashtagsTable.hashtagId);

  for (const { hashtagId, cnt } of joinCounts) {
    await db.update(hashtagsTable).set({ factCount: cnt }).where(eq(hashtagsTable.id, hashtagId));
  }

  console.log(
    `Seeded ${insertedFacts.length} facts and ${insertedHashtags.length} hashtags.`,
  );
}

seed()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
