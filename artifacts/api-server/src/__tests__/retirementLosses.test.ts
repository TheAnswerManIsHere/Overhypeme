/**
 * The upgrade rehearsal's expectation for migration 0142 (plan
 * docs/plans/PLAN_RETIRE_VARIANTS.md, Testing Plan item 5; PR #970 round 1).
 *
 * `variantRetirementLosses` counts, per table and before 0142 runs, the rows
 * 0142 will delete. These tests plant a variant population on the pre-0142
 * shape, take the expectation, run the real migration file, and require every
 * table's count afterwards to equal its count before minus the expectation —
 * exactly, in every table of the schema. A negative control loses one extra
 * row in an affected table and must be told apart; a database without the
 * parent column gets no allowance at all.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { variantRetirementLosses } from "../lib/retirementLosses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(path.resolve(__dirname, "../../../../lib/db/migrations/0142_retire_variants.sql"), "utf8");
const P = `t_rl_${randomUUID().slice(0, 8)}_`;

async function one<T>(q: ReturnType<typeof sql>): Promise<T> {
  return (await db.execute(q)).rows[0] as T;
}

/** Every table of the connection's schema, with its row count. */
async function counts(): Promise<Map<string, number>> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ t: string }>(
      "SELECT relname AS t FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' ORDER BY 1",
    );
    const out = new Map<string, number>();
    for (const { t } of rows) out.set(t, Number((await client.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n));
    return out;
  } finally {
    client.release();
  }
}

async function losses() {
  const client = await pool.connect();
  try {
    return await variantRetirementLosses(client);
  } finally {
    client.release();
  }
}

async function preRetirementShape() {
  await db.execute(sql`ALTER TABLE facts ADD COLUMN IF NOT EXISTS parent_id integer`);
  await db.execute(sql`ALTER TABLE facts ADD COLUMN IF NOT EXISTS use_case varchar(50)`);
  await db.execute(sql`ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS parent_fact_id integer REFERENCES facts(id) ON DELETE SET NULL`);
}

async function postRetirementShape() {
  await db.execute(sql`ALTER TABLE facts DROP COLUMN IF EXISTS parent_id`);
  await db.execute(sql`ALTER TABLE facts DROP COLUMN IF EXISTS use_case`);
  await db.execute(sql`ALTER TABLE pending_reviews DROP COLUMN IF EXISTS parent_fact_id`);
}

async function cleanup() {
  await db.execute(sql`DELETE FROM activity_feed WHERE user_id LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM reactions WHERE user_id LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM pending_reviews WHERE submitted_text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM facts WHERE text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${P + "%"}`);
}

/** A root, a bystander and three variants with memes, comments, reactions, reviews and activity. */
async function plant(): Promise<{ bystander: number; userId: string }> {
  const userId = `${P}user`;
  await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${userId + "@example.test"})`);
  const live = async (key: string) =>
    (await insertLiveFact({ text: `${P}${key}`, enrichment: buildPlaceholderFactEnrichment() }, buildPlaceholderGag())).id;
  const root = await live("root");
  const bystander = await live("bystander");
  const v1 = await live("v1");
  const v2 = await live("v2");
  const v3 = (await one<{ id: number }>(sql`INSERT INTO facts (text, is_active) VALUES (${P + "v3"}, false) RETURNING id`)).id;
  await db.execute(sql`UPDATE facts SET parent_id = ${root} WHERE id IN (${v1}, ${v2}, ${v3})`);
  const meme = await one<{ id: number }>(sql`
    INSERT INTO memes (fact_id, template_id, image_url, permalink_slug)
    VALUES (${v1}, 'classic', '/x.png', ${("r" + randomUUID().replace(/-/g, "")).slice(0, 16)}) RETURNING id`);
  await db.execute(sql`INSERT INTO share_intents (meme_id, user_id, platform) VALUES (${meme.id}, ${userId}, 'x')`);
  const comment = await one<{ id: number }>(sql`INSERT INTO comments (fact_id, author_id, text) VALUES (${v2}, ${userId}, 'hi') RETURNING id`);
  await db.execute(sql`INSERT INTO reactions (user_id, target_type, target_id, reaction_type) VALUES
    (${userId}, 'fact', ${v1}, 'up'), (${userId}, 'meme', ${meme.id}, 'heart'), (${userId}, 'comment', ${comment.id}, 'heart'),
    (${userId}, 'fact', ${bystander}, 'up')`);
  const review = await one<{ id: number }>(sql`
    INSERT INTO pending_reviews (submitted_text, submitted_by_id, status, workflow_stage, staging_fact_id, approved_fact_id)
    VALUES (${P + "review"}, ${userId}, 'approved', 'production_approved', ${v1}, ${v1}) RETURNING id`);
  await db.execute(sql`INSERT INTO pending_reviews (submitted_text, submitted_by_id, status, workflow_stage, matching_fact_id)
    VALUES (${P + "match"}, ${userId}, 'pending', 'triage_pending', ${v2})`);
  await db.execute(sql`INSERT INTO activity_feed (user_id, action_type, message, metadata) VALUES
    (${userId}, 'review_approved', 'approved', ${JSON.stringify({ reviewId: review.id, factId: v1 })}::jsonb),
    (${userId}, 'comment_posted', 'commented', ${JSON.stringify({ commentId: comment.id, factId: v2 })}::jsonb),
    (${userId}, 'comment_posted', 'elsewhere', ${JSON.stringify({ factId: bystander })}::jsonb)`);
  return { bystander, userId };
}

/** The tables whose after-count differs from before minus the expectation. */
function mismatches(beforeCounts: Map<string, number>, afterCounts: Map<string, number>, expected: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [t, n] of beforeCounts) {
    const want = n - (expected.get(t) ?? 0);
    if (afterCounts.get(t) !== want) out.push(`${t}: had ${n}, expected ${want}, now ${afterCounts.get(t)}`);
  }
  return out;
}

describe("variantRetirementLosses: the rehearsal's expectation for 0142", () => {
  before(cleanup);
  after(async () => {
    await postRetirementShape();
    await cleanup();
  });

  it("gives no allowance to a database without the parent column", async () => {
    await postRetirementShape();
    assert.equal((await losses()).size, 0);
  });

  it("gives no allowance to a database with the column and no variant", async () => {
    await preRetirementShape();
    assert.equal((await losses()).size, 0);
  });

  it("predicts exactly what 0142 deletes, table by table, and nothing else moves", async () => {
    await preRetirementShape();
    await plant();
    const expected = await losses();
    assert.equal(expected.get("facts"), 3, "the three variant facts");
    assert.equal(expected.get("reactions"), 3, "the reactions on a variant, its meme and its comment, not the bystander's");
    assert.equal(expected.get("activity_feed"), 2, "the approval and the comment on a variant, not the bystander's");
    assert.equal(expected.get("pending_reviews"), 1, "the review that staged and approved a variant, not the one that only matched");
    assert.equal(expected.get("share_intents"), 1, "two levels down: a variant's meme's share");
    const beforeCounts = await counts();
    await db.execute(sql.raw(MIGRATION_SQL));
    const afterCounts = await counts();
    assert.deepEqual(mismatches(beforeCounts, afterCounts, expected), []);
  });

  it("tells an extra loss in an affected table apart from the intended deletion", async () => {
    await cleanup();
    await preRetirementShape();
    const { bystander } = await plant();
    const expected = await losses();
    const beforeCounts = await counts();
    await db.execute(sql.raw(MIGRATION_SQL));
    // An unrelated row lost in a table that legitimately loses rows too.
    await db.execute(sql`DELETE FROM reactions WHERE target_type = 'fact' AND target_id = ${bystander}`);
    const afterCounts = await counts();
    const found = mismatches(beforeCounts, afterCounts, expected);
    assert.equal(found.length, 1, found.join("; "));
    assert.match(found[0]!, /^reactions: /);
  });
});
