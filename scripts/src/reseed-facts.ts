/**
 * One-time script: clears the facts table and re-inserts from the canonical
 * seed-facts list with proper tokenization and canonical_text pre-computed.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts exec tsx src/reseed-facts.ts
 *
 * Safe to run multiple times — always starts with a full wipe of facts/hashtag data.
 */

import { db } from "@workspace/db";
import {
  factsTable, hashtagsTable, factHashtagsTable,
  commentsTable, ratingsTable, memesTable, externalLinksTable, pendingReviewsTable,
} from "@workspace/db/schema";
import { sql, eq } from "drizzle-orm";

// ---------- inline renderCanonical (mirrors artifacts/api-server/src/lib/renderCanonical.ts) ----------
const TOKEN_MAP: Record<string, string> = {
  NAME: "Alex",
  SUBJ: "they", Subj: "They",
  OBJ: "them",  Obj: "Them",
  POSS: "their", Poss: "Their",
  POSS_PRO: "theirs", Poss_Pro: "Theirs",
  REFL: "themselves", Refl: "Themselves",
};

function renderCanonical(template: string): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
    if (inner in TOKEN_MAP) return TOKEN_MAP[inner];
    if (inner.includes("|")) {
      const parts = inner.split("|");
      return parts[parts.length - 1];
    }
    return _match;
  });
}

// ---------- seed data ----------
const HAS_PRONOUN_RE = /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/;

const SEED_FACTS: Array<{ text: string; hashtags: string[] }> = [
  { text: "When {NAME} {does|do} pushups, {SUBJ} {doesn't|don't} push {REFL} up — {SUBJ} {pushes|push} the Earth down.", hashtags: ["impossible", "legendary", "strong"] },
  { text: "{NAME} can divide by zero.", hashtags: ["impossible", "math", "smart"] },
  { text: "Death once had a near-{NAME} experience.", hashtags: ["death", "legendary", "unstoppable"] },
  { text: "{NAME} {has|have} counted to infinity — twice.", hashtags: ["impossible", "legendary", "smart"] },
  { text: "Superman wears {NAME} pajamas.", hashtags: ["legendary", "strong", "superman"] },
  { text: "When {NAME} enters a room, {SUBJ} {doesn't|don't} turn the lights on — {SUBJ} {turns|turn} the dark off.", hashtags: ["badass", "impossible", "legendary"] },
  { text: "{NAME} can hear sign language.", hashtags: ["impossible", "smart", "witty"] },
  { text: "{NAME} {makes|make} onions cry.", hashtags: ["legendary", "tough", "witty"] },
  { text: "{NAME} once kicked a horse in the chin. Its descendants are known today as giraffes.", hashtags: ["animals", "legendary", "strong", "witty"] },
  { text: "When {NAME} {was|were} born, {SUBJ} drove {POSS} mom home from the hospital.", hashtags: ["badass", "legendary", "witty"] },
  { text: "{NAME} can slam a revolving door.", hashtags: ["impossible", "witty"] },
  { text: "{NAME}'s tears cure cancer. Too bad {SUBJ} {has|have} never cried.", hashtags: ["legendary", "sad", "tough"] },
  { text: "Time waits for no one. Unless that person is {NAME}.", hashtags: ["impossible", "legendary", "time"] },
  { text: "{NAME} {was|were} once in a knife fight, and the knife lost.", hashtags: ["badass", "strong", "tough"] },
  { text: "{NAME} can build a snowman out of rain.", hashtags: ["impossible", "legendary", "witty"] },
  { text: "{NAME} can delete the recycle bin without right-clicking.", hashtags: ["computers"] },
  { text: "{NAME} {does|do} not sleep. {Subj} {waits|wait}.", hashtags: ["fear", "strength"] },
  { text: "{NAME} once won a staring contest against {POSS} own reflection.", hashtags: ["fear"] },
  { text: "{NAME} {does|do} not wear a watch. {Subj} {decides|decide} what time it is.", hashtags: ["time"] },
  { text: "{NAME} can set ants on fire with a magnifying glass. At night.", hashtags: ["impossible", "legendary"] },
  { text: "{NAME} {doesn't|don't} wear sunglasses — the sun wears {NAME} glasses.", hashtags: ["impossible"] },
  { text: "{NAME} {doesn't|don't} read books. {Subj} {stares|stare} them down until {SUBJ} {gets|get} the information {SUBJ} {wants|want}.", hashtags: ["wisdom", "strength"] },
  { text: "{NAME} can sneeze with {POSS} eyes open.", hashtags: ["supernatural", "senses"] },
  { text: "{NAME} once parallel parked a train.", hashtags: ["vehicles", "strength"] },
  { text: "{NAME} once threw a grenade and killed 50 people — then it exploded.", hashtags: ["explosions", "strength"] },
  { text: "{NAME} can win a game of Connect Four in only three moves.", hashtags: ["games", "wisdom"] },
  { text: "{NAME} typed at 300 words per minute with {POSS} toes.", hashtags: ["computers", "strength"] },
  { text: "{NAME} once won a staring contest against a blind person — twice.", hashtags: ["impossible", "legendary"] },
  { text: "{NAME} {makes|make} the Impossible sign possible.", hashtags: ["impossible", "legendary"] },
  { text: "{NAME} can slam a door open.", hashtags: ["impossible", "strength"] },
];

// ---------- main ----------
console.log("Starting facts reseed…");

// 1. Wipe all dependent tables first, then facts and hashtags
// Order matters: children before parents to satisfy FK constraints
await db.delete(commentsTable);
console.log("  ✓ Cleared comments");
await db.delete(ratingsTable);
console.log("  ✓ Cleared ratings");
await db.delete(memesTable);
console.log("  ✓ Cleared memes");
await db.delete(externalLinksTable);
console.log("  ✓ Cleared external_links");
// Nullify pending_reviews FK references to facts before deleting facts
await db.execute(sql`UPDATE pending_reviews SET approved_fact_id = NULL, matching_fact_id = NULL`);
console.log("  ✓ Nullified pending_reviews fact references");
await db.delete(factHashtagsTable);
console.log("  ✓ Cleared fact_hashtags");
await db.delete(factsTable);
console.log("  ✓ Cleared facts");
await db.delete(hashtagsTable);
console.log("  ✓ Cleared hashtags");

// 2. Build unique hashtag set
const allTags = [...new Set(SEED_FACTS.flatMap((f) => f.hashtags))];
const insertedTags = await db
  .insert(hashtagsTable)
  .values(allTags.map((name) => ({ name })))
  .onConflictDoNothing()
  .returning();
const tagMap = new Map<string, number>(insertedTags.map((t) => [t.name, t.id]));
console.log(`  ✓ Inserted ${insertedTags.length} hashtags`);

// 3. Insert facts with canonical_text and isActive
let inserted = 0;
for (const item of SEED_FACTS) {
  const canonicalText = renderCanonical(item.text);
  const hasPronouns = HAS_PRONOUN_RE.test(item.text);

  const [fact] = await db
    .insert(factsTable)
    .values({
      text: item.text,
      canonicalText,
      hasPronouns,
      isActive: true,
    })
    .returning({ id: factsTable.id });

  for (const tag of item.hashtags) {
    const tagId = tagMap.get(tag);
    if (!tagId) continue;
    await db.insert(factHashtagsTable).values({ factId: fact.id, hashtagId: tagId }).onConflictDoNothing();
    await db.update(hashtagsTable).set({ factCount: sql`${hashtagsTable.factCount} + 1` }).where(eq(hashtagsTable.id, tagId));
  }

  inserted++;
  console.log(`  [${inserted}/${SEED_FACTS.length}] #${fact.id} — ${item.text.slice(0, 60)}…`);
}

console.log(`\nDone. Inserted ${inserted} facts with canonical_text.`);
process.exit(0);
