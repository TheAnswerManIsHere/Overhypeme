/**
 * Migration 0142 (plan docs/plans/PLAN_RETIRE_VARIANTS.md, "Data Model and
 * Migration Impact"): every variant fact (a fact with a parent) is deleted with
 * what it owns, and the parent link is dropped.
 *
 * The test database is built past 0142, so the test recreates the state 0142
 * runs on: the three columns are re-added, the planted rows are written, and
 * running the migration drops the columns again.
 *
 * What it proves, per the plan's Testing Plan item 1 and 2:
 * - exactly the owned population goes: variant facts (active, inactive,
 *   orphaned, mid-refresh with a pending example or a pending removal), their
 *   memes, comments, gags and hashtag links, the reactions on those facts, memes
 *   and comments, the activity entries recording them, and the reviews that
 *   staged or approved them;
 * - every other row of the tables it touches is equal before and after on every
 *   surviving column, the only differences being the named ones: a review that
 *   only matched a variant loses its pointer, a hashtag's fact count drops by the
 *   variant links it carried, and the "possible variant" wording becomes
 *   "possible duplicate";
 * - a reaction on a standalone fact whose id equals a deleted variant's meme id
 *   is kept (the reaction table is polymorphic, so the type must match);
 * - a submission that carried a parent and never became a fact stays in triage;
 * - a second run, with the columns gone, changes nothing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0142_retire_variants.sql"), "utf8");
const P = `t_0142_${randomUUID().slice(0, 8)}_`;

type Row = Record<string, unknown>;

async function rows(q: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(q)).rows as Row[];
}
async function one<T>(q: ReturnType<typeof sql>): Promise<T> {
  return (await rows(q))[0] as T;
}

const TABLES = [
  "facts", "pending_reviews", "reactions", "activity_feed", "memes", "share_intents", "comments",
  "fact_gags", "fact_hashtags", "hashtags", "image_prompt_attempts",
] as const;

/** Every row of every table the migration touches, keyed `table:<id>` (fact_hashtags by its pair). */
async function snapshot(): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (const t of TABLES) {
    const all = await rows(sql.raw(`SELECT to_jsonb(x) AS r FROM ${t} x`));
    for (const { r } of all as Array<{ r: Row }>) {
      const key = t === "fact_hashtags" ? `${t}:${r.fact_id}-${r.hashtag_id}` : `${t}:${r.id}`;
      out.set(key, r);
    }
  }
  return out;
}

async function columnsPresent(): Promise<string[]> {
  return (await rows(sql`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND ((table_name = 'facts' AND column_name IN ('parent_id','use_case'))
         OR (table_name = 'pending_reviews' AND column_name = 'parent_fact_id'))
     ORDER BY 1`)).map((r) => String(r.c));
}

async function restorePostState() {
  await db.execute(sql`DROP INDEX IF EXISTS facts_parent_id_idx`);
  await db.execute(sql`ALTER TABLE facts DROP COLUMN IF EXISTS parent_id`);
  await db.execute(sql`ALTER TABLE facts DROP COLUMN IF EXISTS use_case`);
  await db.execute(sql`DROP INDEX IF EXISTS idx_pending_reviews_parent_fact`);
  await db.execute(sql`ALTER TABLE pending_reviews DROP COLUMN IF EXISTS parent_fact_id`);
}

async function cleanup() {
  await db.execute(sql`DELETE FROM activity_feed WHERE user_id LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM reactions WHERE user_id LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM pending_reviews WHERE submitted_text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM facts WHERE text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM hashtags WHERE name LIKE ${P.toLowerCase().replace(/[^a-z0-9_]/g, "") + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${P + "%"}`);
}

describe("migration 0142: variants are retired", () => {
  const ids: Record<string, number> = {};
  let userId = "";
  let snapBefore: Map<string, Row>;
  let snapAfter: Map<string, Row>;
  let deleted: Set<string>;

  before(async () => {
    await cleanup();
    // The pre-0142 shape.
    await db.execute(sql`ALTER TABLE facts ADD COLUMN IF NOT EXISTS parent_id integer`);
    await db.execute(sql`ALTER TABLE facts ADD COLUMN IF NOT EXISTS use_case varchar(50)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS facts_parent_id_idx ON facts (parent_id)`);
    await db.execute(sql`ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS parent_fact_id integer REFERENCES facts(id) ON DELETE SET NULL`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pending_reviews_parent_fact ON pending_reviews (parent_fact_id)`);

    userId = `${P}user`;
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${userId + "@example.test"})`);

    const live = async (key: string) => {
      const f = await insertLiveFact({ text: `${P}${key}`, enrichment: buildPlaceholderFactEnrichment() }, buildPlaceholderGag());
      ids[key] = f.id;
      return f.id;
    };
    const inactive = async (key: string) => {
      ids[key] = (await one<{ id: number }>(sql`INSERT INTO facts (text, is_active) VALUES (${P + key}, false) RETURNING id`)).id;
      return ids[key]!;
    };
    const review = async (key: string, cols: { staging?: number; approved?: number; matching?: number; parent?: number; stage?: string }) => {
      ids[key] = (await one<{ id: number }>(sql`
        INSERT INTO pending_reviews (submitted_text, submitted_by_id, status, workflow_stage, staging_fact_id, approved_fact_id, matching_fact_id, parent_fact_id)
        VALUES (${P + key}, ${userId}, 'pending', ${cols.stage ?? "triage"}::review_workflow_stage,
                ${cols.staging ?? null}, ${cols.approved ?? null}, ${cols.matching ?? null}, ${cols.parent ?? null})
        RETURNING id`)).id;
      return ids[key]!;
    };

    // The standalone facts: a root, and a bystander that shares its hashtag.
    const root = await live("root");
    const bystander = await live("bystander");

    // Variants: active, inactive, orphaned, and two mid-refresh.
    const vActive = await live("vActive");
    const vInactive = await inactive("vInactive");
    const vOrphan = await live("vOrphan");
    const vRemove = await live("vRemove");
    const vExample = await live("vExample");
    await db.execute(sql`UPDATE facts SET parent_id = ${root}, use_case = 'short' WHERE id IN (${vActive}, ${vInactive}, ${vRemove}, ${vExample})`);
    await db.execute(sql`UPDATE facts SET parent_id = 2000000000 WHERE id = ${vOrphan}`);

    // What a variant owns.
    const meme = await one<{ id: number }>(sql`
      INSERT INTO memes (fact_id, template_id, image_url, permalink_slug)
      VALUES (${vActive}, 'classic', '/x.png', ${("m" + randomUUID().replace(/-/g, "")).slice(0, 16)}) RETURNING id`);
    ids.meme = meme.id;
    await db.execute(sql`INSERT INTO share_intents (meme_id, user_id, platform) VALUES (${meme.id}, ${userId}, 'x')`);
    ids.comment = (await one<{ id: number }>(sql`INSERT INTO comments (fact_id, author_id, text) VALUES (${vActive}, ${userId}, 'nice') RETURNING id`)).id;
    await db.execute(sql`INSERT INTO reactions (user_id, target_type, target_id, reaction_type) VALUES
      (${userId}, 'fact', ${vActive}, 'up'), (${userId}, 'meme', ${meme.id}, 'heart'), (${userId}, 'comment', ${ids.comment}, 'heart')`);

    // A standalone fact whose id equals the variant's meme id keeps its reaction.
    const taken = await rows(sql`SELECT id, parent_id FROM facts WHERE id = ${meme.id}`);
    if (taken.length === 0) {
      await db.execute(sql`INSERT INTO facts (id, text, is_active) VALUES (${meme.id}, ${P + "collision"}, false)`);
      await db.execute(sql`SELECT setval(pg_get_serial_sequence('facts', 'id'), greatest((SELECT max(id) FROM facts), 1))`);
    } else {
      assert.equal(taken[0]!.parent_id, null, "the colliding fact must be standalone");
    }
    ids.collision = meme.id;
    await db.execute(sql`INSERT INTO reactions (user_id, target_type, target_id, reaction_type) VALUES (${userId}, 'fact', ${meme.id}, 'heart')`);

    // Hashtag shared by the root, the bystander and one variant.
    const tag = (P.toLowerCase().replace(/[^a-z0-9_]/g, "") + "tag").slice(0, 60);
    ids.tag = (await one<{ id: number }>(sql`INSERT INTO hashtags (name, fact_count) VALUES (${tag}, 3) RETURNING id`)).id;
    await db.execute(sql`INSERT INTO fact_hashtags (fact_id, hashtag_id) VALUES (${root}, ${ids.tag}), (${bystander}, ${ids.tag}), (${vActive}, ${ids.tag})`);

    // Reviews: the ones that staged or approved a variant are owned...
    const rApproved = await review("rApproved", { staging: vActive, approved: vActive, stage: "approved" });
    const rRemove = await review("rRemove", { staging: vRemove, stage: "gags" });
    const rExample = await review("rExample", { staging: vExample, stage: "gags" });
    // ...one that only matched a variant is not, nor one that carried a parent and never became a fact.
    const rMatch = await review("rMatch", { matching: vActive });
    const rHalfMade = await review("rHalfMade", { parent: root });

    // Mid-refresh gags: a pending removal, and a pending example (needs a render).
    await db.execute(sql`UPDATE fact_gags SET pending_review_id = ${rRemove}, pending_remove = true WHERE fact_id = ${vRemove}`);
    const attempt = await one<{ id: number }>(sql`
      INSERT INTO image_prompt_attempts (fact_id, generation_mode, subject_render_mode, target_engine, source_image_analysis, identity_policy, render_controls, fact_enrichment_snapshot, archetype_strategy_version)
      VALUES (${vExample}, 't2i', 't2i_fallback', 'nano-banana-2', '{}', '{}', '{}', '{}', '1') RETURNING id::integer AS id`);
    await db.execute(sql`UPDATE fact_gags SET pending_review_id = ${rExample}, pending_content = approved_content, pending_example_attempt_id = ${attempt.id} WHERE fact_id = ${vExample}`);

    // Activity: owned entries (a variant's approval, a comment on it), and kept ones.
    await db.execute(sql`INSERT INTO activity_feed (user_id, action_type, message, metadata) VALUES
      (${userId}, 'review_approved', ${"Your submitted fact was approved as a variant of fact #" + root + " and added to the database!"}, ${JSON.stringify({ reviewId: rApproved, factId: vActive, parentFactId: root })}::jsonb),
      (${userId}, 'comment_posted', 'You commented.', ${JSON.stringify({ commentId: ids.comment, factId: vActive })}::jsonb),
      (${userId}, 'review_submitted', 'You submitted a fact for admin review — flagged as a possible variant at 91% similarity.', ${JSON.stringify({ reviewId: rMatch, matchingFactId: vActive })}::jsonb),
      (${userId}, 'review_submitted', 'You submitted a fact for admin review.', ${JSON.stringify({ reviewId: rHalfMade })}::jsonb),
      (${userId}, 'comment_posted', 'Elsewhere.', ${JSON.stringify({ factId: String(vActive) })}::jsonb)`);

    snapBefore = await snapshot();
    await db.execute(sql.raw(MIGRATION_SQL));
    snapAfter = await snapshot();

    const variantIds = [vActive, vInactive, vOrphan, vRemove, vExample];
    deleted = new Set<string>([
      ...variantIds.map((i) => `facts:${i}`),
      `memes:${meme.id}`, `comments:${ids.comment}`,
      `pending_reviews:${rApproved}`, `pending_reviews:${rRemove}`, `pending_reviews:${rExample}`,
      `fact_hashtags:${vActive}-${ids.tag}`,
      `image_prompt_attempts:${attempt.id}`,
    ]);
    for (const [key, r] of snapBefore) {
      const [table] = key.split(":");
      if (table === "fact_gags" && variantIds.includes(Number(r.fact_id))) deleted.add(key);
      if (table === "share_intents" && r.meme_id === meme.id) deleted.add(key);
      if (table === "reactions" && r.user_id === userId && (
        (r.target_type === "fact" && r.target_id === vActive) ||
        (r.target_type === "meme" && r.target_id === meme.id) ||
        (r.target_type === "comment" && r.target_id === ids.comment))) deleted.add(key);
      if (table === "activity_feed" && r.user_id === userId) {
        const m = r.metadata as Row;
        if (m.factId === vActive || m.reviewId === rApproved) deleted.add(key);
      }
    }
  });

  after(async () => {
    await restorePostState();
    await cleanup();
  });

  it("drops the three columns", async () => {
    assert.deepEqual(await columnsPresent(), []);
  });

  it("deletes exactly the owned population", () => {
    const gone = [...snapBefore.keys()].filter((k) => !snapAfter.has(k)).sort();
    assert.deepEqual(gone, [...deleted].sort());
    const added = [...snapAfter.keys()].filter((k) => !snapBefore.has(k));
    assert.deepEqual(added, [], "nothing is created");
  });

  it("leaves every other row equal on every surviving column, apart from the named changes", () => {
    for (const [key, was] of snapBefore) {
      if (deleted.has(key)) continue;
      const expected: Row = { ...was };
      delete expected.parent_id;
      delete expected.use_case;
      delete expected.parent_fact_id;
      const [table, id] = key.split(":");
      if (table === "pending_reviews" && Number(id) === ids.rMatch) expected.matching_fact_id = null;
      if (table === "hashtags" && Number(id) === ids.tag) expected.fact_count = 2;
      if (table === "activity_feed" && typeof was.message === "string" && was.message.includes("possible variant at")) {
        expected.message = was.message.replace("possible variant at", "possible duplicate at");
      }
      assert.deepEqual(snapAfter.get(key), expected, key);
    }
  });

  it("keeps the matching-only submission, its activity entry, and the half-made variant in triage", () => {
    const match = snapAfter.get(`pending_reviews:${ids.rMatch}`)!;
    assert.equal(match.matching_fact_id, null);
    const half = snapAfter.get(`pending_reviews:${ids.rHalfMade}`)!;
    assert.equal(half.workflow_stage, "triage");
    assert.equal(half.status, "pending");
    assert.equal("parent_fact_id" in half, false);
    const reworded = [...snapAfter.values()].filter((r) => r.user_id === userId && String(r.message).includes("possible duplicate at 91%"));
    assert.equal(reworded.length, 1);
  });

  it("keeps a reaction on a standalone fact whose id equals the deleted meme's id", () => {
    const kept = [...snapAfter.values()].filter((r) => r.user_id === userId && r.target_type === "fact" && r.target_id === ids.collision);
    assert.equal(kept.length, 1);
  });

  it("a second run, with the columns gone, changes nothing", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    const again = await snapshot();
    assert.deepEqual([...again.keys()].sort(), [...snapAfter.keys()].sort());
    for (const [k, v] of snapAfter) assert.deepEqual(again.get(k), v, k);
  });
});
