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
import { RETIRED_ADMIN_CONFIG_KEYS, RETIRED_AI_SETTING_KEYS, isIntendedSettingChange, isRetiredSettingValue, mergeLosses, refreshRetirementLosses, retiredSettingLosses, rowRetirementLosses, variantRetirementLosses } from "../lib/retirementLosses.js";

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
    VALUES (${P + "review"}, ${userId}, 'approved', 'approved', ${v1}, ${v1}) RETURNING id`);
  await db.execute(sql`INSERT INTO pending_reviews (submitted_text, submitted_by_id, status, workflow_stage, matching_fact_id)
    VALUES (${P + "match"}, ${userId}, 'pending', 'triage', ${v2})`);
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

describe("a retired setting is an intended deletion (0149)", () => {
  const KEY = "review_duplicate_threshold";
  it("counts the retired row when present, nothing when absent, and names only retired values", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Start from no retired rows, whatever an earlier file in this shard
      // left behind (rolled back with the rest).
      await client.query(`DELETE FROM admin_config WHERE key = ANY($1::text[])`, [[...RETIRED_ADMIN_CONFIG_KEYS, ...RETIRED_AI_SETTING_KEYS]]);
      await client.query(
        `INSERT INTO admin_config (key, value, data_type, label) VALUES ($1, '80', 'integer', 'x') ON CONFLICT (key) DO NOTHING`,
        [KEY],
      );
      assert.deepEqual([...await retiredSettingLosses(client)], [["admin_config", 1]]);
      await client.query(`DELETE FROM admin_config WHERE key = $1`, [KEY]);
      assert.deepEqual([...await retiredSettingLosses(client)], []);
      await client.query("ROLLBACK");
    } finally {
      // A failed assertion must not hand the pool a connection mid-transaction:
      // the next file's writes would land in it and never commit.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    assert.equal(isRetiredSettingValue(`admin_config/${KEY}/value`), true);
    assert.equal(isRetiredSettingValue("admin_config/review_duplicate_threshold_other/value"), false);
    assert.equal(isRetiredSettingValue("admin_config/email_max_attempts/value"), false);
    assert.deepEqual([...mergeLosses(new Map([["facts", 2]]), new Map([["facts", 1], ["admin_config", 1]]))], [["facts", 3], ["admin_config", 1]]);
  });
});

// Issue #1294: the rehearsal counts on the frozen snapshot, which predates
// 0139 and 0143, so fact_gags and fact_gag_examples do not exist there. A
// counting step that reads a table the database lacks must skip it, never throw.
describe("refreshRetirementLosses on a database older than the gag tables (#1294)", () => {
  const schema = `t_rl_old_${randomUUID().slice(0, 8)}`;

  after(async () => {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
  });

  it("counts the refresh reviews and skips the gag examples it cannot have", async () => {
    // The shape the snapshot gives the tables this step reads; no fact_gags, no fact_gag_examples.
    await db.execute(sql.raw(`
      CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".facts (id serial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "${schema}".pending_reviews (
        id serial PRIMARY KEY, staging_fact_id integer REFERENCES "${schema}".facts(id),
        candidate_version_id integer, status varchar NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "${schema}".async_jobs (id serial PRIMARY KEY, queue varchar NOT NULL, status varchar NOT NULL, payload jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE "${schema}".fact_enrichment_versions (id serial PRIMARY KEY, status varchar NOT NULL);
      INSERT INTO "${schema}".facts DEFAULT VALUES;
      INSERT INTO "${schema}".pending_reviews (staging_fact_id, candidate_version_id) VALUES (1, 7);
      INSERT INTO "${schema}".fact_enrichment_versions (status) VALUES ('candidate'), ('current');
    `));
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      const losses = await refreshRetirementLosses(client);
      assert.deepEqual(Object.fromEntries(losses), { fact_enrichment_versions: 1, pending_reviews: 1 });
    } finally {
      await client.query("RESET search_path");
      client.release();
    }
  });
});

// Issue #1302: on the frozen snapshot the rehearsal's first full run failed on
// deletions and changes migrations made on purpose but never declared, and it
// over-counted pending_reviews because 0142's and 0151's counts were summed.
describe("every intended deletion is declared once (#1302)", () => {
  const schema = `t_rl_rows_${randomUUID().slice(0, 8)}`;

  after(async () => {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
  });

  it("counts a row two migrations would delete once: 0142 and 0151 share a review, 0142 and 0145 an attempt", async () => {
    // The snapshot's shape for what these steps read; no comparison or gag tables.
    await db.execute(sql.raw(`
      CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".facts (id serial PRIMARY KEY, parent_id integer, created_at timestamptz NOT NULL DEFAULT now() - interval '1 day');
      CREATE TABLE "${schema}".memes (id serial PRIMARY KEY, fact_id integer);
      CREATE TABLE "${schema}".comments (id serial PRIMARY KEY, fact_id integer);
      CREATE TABLE "${schema}".pending_reviews (
        id serial PRIMARY KEY, staging_fact_id integer, approved_fact_id integer,
        candidate_version_id integer, status varchar NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "${schema}".image_prompt_attempts (
        id serial PRIMARY KEY, fact_id integer REFERENCES "${schema}".facts(id) ON DELETE CASCADE,
        source_image_analysis jsonb NOT NULL DEFAULT '{}', visual_plan jsonb,
        review_render_scenario_key varchar(40), eval_scenario_key varchar(40), review_reference_identity_type varchar(32));
      CREATE TABLE "${schema}".async_jobs (id serial PRIMARY KEY, queue varchar NOT NULL, status varchar NOT NULL, payload jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE "${schema}".fact_enrichment_versions (id serial PRIMARY KEY, status varchar NOT NULL);
      -- fact 1: an ordinary fact; fact 2: a variant of it.
      INSERT INTO "${schema}".facts (parent_id) VALUES (NULL), (1);
      -- A pending review of the variant, newer than its fact: 0142 deletes it with the
      -- variant, and 0151's resubmission rule would also select it.
      INSERT INTO "${schema}".pending_reviews (staging_fact_id) VALUES (2);
      -- A vehicle render of the variant (0142 cascades it, 0145 would select it),
      -- an object render of the ordinary fact (0145 only), and a person render (kept).
      INSERT INTO "${schema}".image_prompt_attempts (fact_id, source_image_analysis) VALUES
        (2, '{"subjectKind":"vehicle_subject"}'), (1, '{"subjectKind":"object_subject"}'), (1, '{"subjectKind":"human_face"}');
    `));
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      const losses = await rowRetirementLosses(client);
      assert.deepEqual(Object.fromEntries(losses), { facts: 1, pending_reviews: 1, image_prompt_attempts: 2 });
      // The old way, each step counted on its own and the counts summed, counts the shared rows twice.
      const { peopleAndPetsLosses } = await import("../lib/retirementLosses.js");
      const summed = mergeLosses(await variantRetirementLosses(client), await peopleAndPetsLosses(client), await refreshRetirementLosses(client));
      assert.deepEqual(Object.fromEntries(summed), { facts: 1, pending_reviews: 2, image_prompt_attempts: 3 });
    } finally {
      await client.query("RESET search_path");
      client.release();
    }
  });

  it("declares 0138's AI settings and 0163's custom_avatar permissions retired, and 0156's reply-to change intended", () => {
    assert.equal(isRetiredSettingValue("admin_config/fact_enrichment_system/value"), true);
    assert.equal(isRetiredSettingValue("admin_config/image_engine_t2i/value_label"), true);
    assert.equal(isRetiredSettingValue("tier_feature_permissions/legendary/custom_avatar/enabled"), true);
    assert.equal(isRetiredSettingValue("tier_feature_permissions/legendary/custom_photo/enabled"), false);
    assert.equal(isRetiredSettingValue("admin_config/email_reply_to/value"), false);
    const key = "admin_config/email_reply_to/value";
    assert.equal(isIntendedSettingChange(key, JSON.stringify("overhypeme+support@gmail.com"), JSON.stringify("support@overhype.me")), true);
    assert.equal(isIntendedSettingChange(key, JSON.stringify("someone@else.test"), JSON.stringify("support@overhype.me")), false, "only from the retired alias");
    assert.equal(isIntendedSettingChange(key, JSON.stringify("overhypeme+support@gmail.com"), undefined), false, "never to absent");
    assert.equal(isIntendedSettingChange("admin_config/site_name/value", "\"a\"", "\"b\""), false);
  });
});
