/**
 * Migration 0143 (plan docs/plans/PLAN_GAG_EXAMPLES.md, "Data Model and
 * Migration Impact"; Testing Plan item 7): a gag's examples move to
 * fact_gag_examples, one per subject kind, COPIED from the retained columns.
 *
 *   - the row-state matrix: an approved example of a kind scenario is copied;
 *     one of a retired scenario is not; a refresh's pick is copied as pending;
 *     every approved gag without a complete set is grandfathered;
 *   - a second run changes nothing;
 *   - both arrival orders: the runner first, and Replit's schema diff first
 *     (the table and column created, the old checks dropped, then the runner);
 *   - afterwards a migrated pick can be discarded, and completed and approved,
 *     and the retained columns stay as they were (a refresh's decline and
 *     promotion are retired: plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1H);
 *   - the reverse script restores the prior structure exactly, and refuses once
 *     a set was approved or a migrated pick discarded or declined.
 *
 * The test database is built past 0143, so each order first recreates the
 * state 0143 runs on (no example table, no grandfathered column, the three old
 * checks as NOT VALID so other files' rows in this shard do not trip them).
 * Dropping the table loses other files' example rows; they have finished, and
 * the migration grandfathers their gags; those that completed a set are made
 * carried over first, as no pre-0143 row lacks both an example and that mark. `after` re-runs the migration, which
 * is idempotent, so the shard ends in the built state whatever failed.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, factGagsTable, pool } from "@workspace/db";

import { discardGagChange } from "../lib/gags/gagStore.js";
import { applyPendingSetIfComplete, putExample } from "../lib/gags/examples.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0143_gag_example_sets.sql"), "utf8");
const REVERSE_SQL = readFileSync(path.join(ROOT, "lib/db/reverse/0143_gag_example_sets.reverse.sql"), "utf8");
/** What Replit's schema diff applies before the runner: the structure, up to the data copy. */
const SCHEMA_DIFF_SQL = MIGRATION_SQL.slice(0, MIGRATION_SQL.indexOf("-- Copy each existing selection"));
const P = "t_0143_";
const RUN = randomUUID().slice(0, 8);

const gag = (scene: string) => ({ version: 1, coreSceneOverride: scene });

async function one<T>(q: ReturnType<typeof sql>): Promise<T> {
  return (await db.execute(q)).rows[0] as T;
}
const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];

/** The structure 0143 runs on. */
async function toPre0143(): Promise<void> {
  // Other files' gags that completed a set under the new model hold no old
  // example: no pre-0143 database has such a row, so they are made carried
  // over, the state they would have arrived in. Its own statement: the live-fact
  // trigger it queues would block the ALTERs below in one transaction.
  await db.execute(sql`UPDATE fact_gags SET approved_carried_over = true
     WHERE approved_content IS NOT NULL AND approved_example_attempt_id IS NULL AND NOT approved_carried_over`);
  await db.execute(sql.raw(`
    DROP TRIGGER IF EXISTS fact_gags_example_set ON fact_gags;
    DROP TABLE IF EXISTS fact_gag_examples;
    DROP FUNCTION IF EXISTS enforce_gag_example_set();
    ALTER TABLE fact_gags DROP COLUMN IF EXISTS approved_before_example_sets;
    ALTER TABLE fact_gags DROP CONSTRAINT IF EXISTS fact_gags_pending_ops_owned;
    ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_pending_ops_owned
      CHECK ((pending_example_attempt_id IS NULL AND NOT pending_remove) OR pending_review_id IS NOT NULL) NOT VALID;
    ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_pending_example_has_content
      CHECK (pending_example_attempt_id IS NULL OR pending_content IS NOT NULL) NOT VALID;
    ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_approved_has_example
      CHECK (approved_content IS NULL OR approved_example_attempt_id IS NOT NULL OR approved_carried_over) NOT VALID;
  `));
}

async function adminUser(): Promise<string> {
  const id = `${P}${RUN}`;
  await db.execute(sql`INSERT INTO users (id, email, is_admin, membership_tier) VALUES (${id}, ${id + "@test.local"}, true, 'legendary') ON CONFLICT (id) DO NOTHING`);
  return id;
}

async function fact(name: string): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO facts (text, is_active, enrichment) VALUES (${`${P}${RUN} ${name}`}, false, '{}'::jsonb) RETURNING id`)).id;
}
async function activate(factId: number): Promise<void> {
  await db.execute(sql`UPDATE facts SET is_active = true WHERE id = ${factId}`);
}
/** A finished render; `drew` is the gag content its snapshot records (what the reverse compares a retained pick against). */
async function attempt(factId: number, gagId: number | null, scenarioKey: string, drew: unknown = null): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO image_prompt_attempts (fact_id, gag_id, review_render_scenario_key, render_job_id, generation_mode, subject_render_mode,
      target_engine, source_image_analysis, identity_policy, render_controls, fact_enrichment_snapshot, archetype_strategy_version, generated_image_object_path)
    VALUES (${factId}, ${gagId}, ${scenarioKey}, ${randomUUID()}, 't2i', 't2i_fallback', 'nano_banana_2', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      ${JSON.stringify(drew == null ? {} : { visualPromptStrategyOverride: drew })}::jsonb, 'v2',
      ${`/objects/ai-bg-v2/${factId}/${randomUUID()}.png`})
    RETURNING id::integer AS id`)).id;
}
async function insertGag(factId: number, slot: number, cols: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(cols);
  const vals = keys.map((k) => {
    const v = cols[k];
    return v != null && typeof v === "object" ? sql`${JSON.stringify(v)}::jsonb` : sql`${v as never}`;
  });
  const q = sql`INSERT INTO fact_gags (fact_id, slot, ${sql.raw(keys.join(", "))}) VALUES (${factId}, ${slot}, ${sql.join(vals, sql`, `)}) RETURNING id::integer AS id`;
  return (await one<{ id: number }>(q)).id;
}
async function review(factId: number, adminId: string): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO pending_reviews (submitted_text, submitted_by_id, status, workflow_stage, staging_fact_id)
    VALUES (${P + "refresh"}, ${adminId}, 'pending', 'production_review', ${factId}) RETURNING id`)).id;
}

interface Seed {
  /** Approved, its example a male render: copied. */
  approvedMale: number; approvedMaleAttempt: number;
  /** Approved, its example a retired generic render: not copied, grandfathered. */
  approvedGeneric: number;
  /** Carried over by 0139, no example. */
  carried: number;
  /** A live gag inside a refresh, with a female pick: copied as pending. */
  refreshing: number; refreshingFact: number; refreshReview: number; refreshPickAttempt: number;
  /** A refresh pick of a retired scenario: not copied. */
  refreshingRetired: number; retiredReview: number;
}

/** The pre-0143 rows, as the old model wrote them. */
async function seed(adminId: string, tag: string): Promise<Seed> {
  const f1 = await fact(`${tag} approved`);
  const approvedMaleAttempt = await attempt(f1, null, "i2i_male_default");
  const approvedMale = await insertGag(f1, 1, { approved_content: gag("{NAME} lifts the moon."), approved_example_attempt_id: approvedMaleAttempt });
  await db.execute(sql`UPDATE image_prompt_attempts SET gag_id = ${approvedMale} WHERE id = ${approvedMaleAttempt}`);
  const genericAttempt = await attempt(f1, null, "generic_t2i");
  const approvedGeneric = await insertGag(f1, 2, { approved_content: gag("{NAME} lifts the sun."), approved_example_attempt_id: genericAttempt });
  const carried = await insertGag(f1, 3, { approved_content: gag("{NAME} lifts a star."), approved_carried_over: true });

  const refreshingFact = await fact(`${tag} refresh`);
  const refreshing = await insertGag(refreshingFact, 1, { approved_content: gag("{NAME} the approved version."), approved_carried_over: true });
  await activate(refreshingFact);
  const refreshReview = await review(refreshingFact, adminId);
  const refreshPickAttempt = await attempt(refreshingFact, refreshing, "i2i_female_default", gag("{NAME} the refresh's change."));
  await db.execute(sql`UPDATE fact_gags SET pending_content = ${JSON.stringify(gag("{NAME} the refresh's change."))}::jsonb,
    pending_example_attempt_id = ${refreshPickAttempt}, pending_review_id = ${refreshReview}, pending_by = ${adminId} WHERE id = ${refreshing}`);

  const f3 = await fact(`${tag} refresh-retired`);
  const refreshingRetired = await insertGag(f3, 1, { approved_content: gag("{NAME} approved."), approved_carried_over: true });
  await activate(f3);
  const retiredReview = await review(f3, adminId);
  const retiredAttempt = await attempt(f3, refreshingRetired, "i2i_nonhuman_object", gag("{NAME} changed."));
  await db.execute(sql`UPDATE fact_gags SET pending_content = ${JSON.stringify(gag("{NAME} changed."))}::jsonb,
    pending_example_attempt_id = ${retiredAttempt}, pending_review_id = ${retiredReview} WHERE id = ${refreshingRetired}`);

  return { approvedMale, approvedMaleAttempt, approvedGeneric, carried, refreshing, refreshingFact, refreshReview, refreshPickAttempt, refreshingRetired, retiredReview };
}

const examplesOf = (gagId: number) =>
  rows<{ subject_kind: string; stage: string; attempt_id: number }>(sql`
    SELECT subject_kind, stage, attempt_id::integer AS attempt_id FROM fact_gag_examples WHERE gag_id = ${gagId} ORDER BY stage, subject_kind`);
const flagsOf = (gagId: number) =>
  one<{ before: boolean; carried: boolean; ex: number | null; pex: number | null }>(sql`
    SELECT approved_before_example_sets AS before, approved_carried_over AS carried,
           approved_example_attempt_id::integer AS ex, pending_example_attempt_id::integer AS pex
      FROM fact_gags WHERE id = ${gagId}`);

/** The matrix, after the migration has run (once or twice). */
async function assertMatrix(s: Seed): Promise<void> {
  assert.deepEqual(await examplesOf(s.approvedMale), [{ subject_kind: "male", stage: "approved", attempt_id: s.approvedMaleAttempt }]);
  assert.equal((await flagsOf(s.approvedMale)).before, true, "one example of three: grandfathered");
  assert.deepEqual(await examplesOf(s.approvedGeneric), [], "a retired scenario's render is not copied");
  assert.equal((await flagsOf(s.approvedGeneric)).before, true);
  assert.deepEqual(await examplesOf(s.carried), []);
  assert.equal((await flagsOf(s.carried)).before, true);
  assert.deepEqual(await examplesOf(s.refreshing), [{ subject_kind: "female", stage: "pending", attempt_id: s.refreshPickAttempt }], "the refresh's pick is copied as pending");
  assert.deepEqual(await examplesOf(s.refreshingRetired), []);
  // The retained columns are untouched snapshots.
  assert.equal((await flagsOf(s.approvedMale)).ex, s.approvedMaleAttempt);
  assert.equal((await flagsOf(s.refreshing)).pex, s.refreshPickAttempt);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`UPDATE facts SET is_active = false WHERE text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM fact_gags WHERE fact_id IN (SELECT id FROM facts WHERE text LIKE ${P + "%"})`);
  await db.execute(sql`DELETE FROM image_prompt_attempts WHERE fact_id IN (SELECT id FROM facts WHERE text LIKE ${P + "%"})`);
  await db.execute(sql`DELETE FROM pending_reviews WHERE submitted_text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM facts WHERE text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${P + "%"}`);
}

describe("migration 0143: a gag's examples, one per kind", () => {
  let adminId = "";

  before(async () => {
    await cleanup();
    adminId = await adminUser();
  });

  after(async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    await cleanup();
  });

  describe("the runner first", () => {
    let s: Seed;
    before(async () => {
      await toPre0143();
      s = await seed(adminId, "runner");
      await db.execute(sql.raw(MIGRATION_SQL));
    });

    it("copies each selection under its kind and grandfathers every approved gag without a set", async () => {
      await assertMatrix(s);
    });

    it("a second run changes nothing", async () => {
      const before = await rows(sql`SELECT * FROM fact_gag_examples ORDER BY id`);
      const flags = await rows(sql`SELECT id, approved_before_example_sets FROM fact_gags ORDER BY id`);
      await db.execute(sql.raw(MIGRATION_SQL));
      assert.deepEqual(await rows(sql`SELECT * FROM fact_gag_examples ORDER BY id`), before);
      assert.deepEqual(await rows(sql`SELECT id, approved_before_example_sets FROM fact_gags ORDER BY id`), flags);
      await assertMatrix(s);
    });
  });

  describe("Replit's schema diff first, then the runner", () => {
    let s: Seed;
    before(async () => {
      await toPre0143();
      s = await seed(adminId, "diff");
      await db.execute(sql.raw(SCHEMA_DIFF_SQL));
      await db.execute(sql.raw(MIGRATION_SQL));
    });

    it("arrives at the same rows", async () => {
      await assertMatrix(s);
    });

    it("a migrated pick can be completed and approved; the retained columns stay as they were", async () => {
      await db.transaction(async (tx) => {
        await putExample(tx, s.refreshing, "male", "pending", await attempt(s.refreshingFact, s.refreshing, "i2i_male_default"), adminId);
        await putExample(tx, s.refreshing, "pet", "pending", await attempt(s.refreshingFact, s.refreshing, "i2i_nonhuman_animal"), adminId);
        const [row] = await tx.select().from(factGagsTable).where(eq(factGagsTable.id, s.refreshing));
        assert.ok(await applyPendingSetIfComplete(tx, row!, adminId), "the third pick applies the change");
      });
      const kinds = (await examplesOf(s.refreshing)).filter((e) => e.stage === "approved").map((e) => e.subject_kind);
      assert.deepEqual(kinds, ["female", "male", "pet"]);
      const f = await flagsOf(s.refreshing);
      assert.equal(f.before || f.carried, false, "its first complete set ends grandfathering");
      assert.equal(f.pex, s.refreshPickAttempt, "the retained column is unchanged");
      const g = await one<{ approved_content: { coreSceneOverride: string } }>(sql`SELECT approved_content FROM fact_gags WHERE id = ${s.refreshing}`);
      assert.equal(g.approved_content.coreSceneOverride, "{NAME} the refresh's change.");
    });

    it("the reverse refuses once a set has been approved under the new model", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await assert.rejects(client.query(REVERSE_SQL), /refused/);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  describe("after the migration: a pick discarded, and the reverse", () => {
    let s: Seed;
    before(async () => {
      await toPre0143();
      await cleanup();
      adminId = await adminUser();
      s = await seed(adminId, "reverse");
      await db.execute(sql.raw(MIGRATION_SQL));
    });

    it("the reverse restores the prior structure exactly while nothing was approved under the new model", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(REVERSE_SQL);
        // Qualified: the inner-loop runner's schema sits in front of public, which has its own copy.
        const t = await client.query("SELECT to_regclass(quote_ident(current_schema()) || '.fact_gag_examples') AS t");
        assert.equal(t.rows[0].t, null);
        const col = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'fact_gags' AND column_name = 'approved_before_example_sets'");
        assert.equal(col.rowCount, 0);
        const checks = await client.query("SELECT conname FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname IN ('fact_gags_approved_has_example', 'fact_gags_pending_example_has_content', 'fact_gags_pending_ops_owned') ORDER BY 1");
        assert.deepEqual(checks.rows.map((r: { conname: string }) => r.conname), ["fact_gags_approved_has_example", "fact_gags_pending_example_has_content", "fact_gags_pending_ops_owned"]);
        const g = await client.query("SELECT approved_example_attempt_id::integer AS ex, pending_example_attempt_id::integer AS pex FROM fact_gags WHERE id = ANY($1::bigint[]) ORDER BY id", [[s.approvedMale, s.refreshing]]);
        assert.deepEqual(g.rows, [{ ex: s.approvedMaleAttempt, pex: null }, { ex: null, pex: s.refreshPickAttempt }], "the previous selections stand");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("the reverse refuses once a migrated pick's content was edited, for a copied pick and for a retired-scenario pick (Codex, PR #972 round 1)", async () => {
      for (const [gagId, copied] of [[s.refreshing, true], [s.refreshingRetired, false]] as const) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // What saving different content does: the new pending content, the
          // copied pick dropped, the retained column and the review ownership kept.
          await client.query("UPDATE fact_gags SET pending_content = $2::jsonb WHERE id = $1", [gagId, JSON.stringify(gag("{NAME} edited after the migration."))]);
          if (copied) await client.query("DELETE FROM fact_gag_examples WHERE gag_id = $1 AND stage = 'pending'", [gagId]);
          await assert.rejects(client.query(REVERSE_SQL), /refused/, copied ? "a copied pick" : "a retired-scenario pick");
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
    });

    it("a migrated pick can be discarded, and the retained column stays as it was", async () => {
      await discardGagChange(s.refreshingFact, s.refreshing, { adminId, reviewId: s.refreshReview });
      assert.deepEqual(await examplesOf(s.refreshing), [], "the pick goes with the change");
      const f = await flagsOf(s.refreshing);
      assert.equal(f.pex, s.refreshPickAttempt);
      const g = await one<{ pending_content: unknown }>(sql`SELECT pending_content FROM fact_gags WHERE id = ${s.refreshing}`);
      assert.equal(g.pending_content, null);
    });
  });
});
