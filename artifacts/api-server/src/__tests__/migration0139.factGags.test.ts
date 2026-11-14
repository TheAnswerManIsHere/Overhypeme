/**
 * Migration 0139 (plan docs/plans/PLAN_THREE_GAGS.md, "Data Model and
 * Migration Impact"): every gag moves out of the enrichment into fact_gags.
 * Each row state of the plan's matrix, byte equality of every moved gag, the
 * capture, a second run that changes nothing, and the reverse script, which
 * rebuilds every prior state and refuses once a gag has been touched.
 *
 * The test database is built past 0139, so the test recreates the state 0139
 * runs on: the live-fact trigger and the one-home CHECKs are dropped while the
 * pre-0139 rows are written (an active fact with no gag row, gags in the
 * enrichment), and running the migration again recreates them.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0139_fact_gags.sql"), "utf8");
const REVERSE_SQL = readFileSync(path.join(ROOT, "lib/db/reverse/0139_fact_gags.reverse.sql"), "utf8");
const LOG = "0139_fact_gags";
const P = "t_0139_";

const ov = (scene: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  coreSceneOverride: scene,
  requiredVisualDetails: [],
  forbiddenVisualDetails: ["a detail only this gag forbids"],
  roleBindings: [],
  bubbles: [{ type: "speech", entity: "subject", text: "Done." }],
  compositionGuidance: [],
  styleAgnosticPromptAdditions: [],
  negativePromptAdditions: [],
  supportingTextPolicyOverride: { mode: "require", guidance: "a sign reading {NAME}" },
  ...extra,
});
const classification = { primaryArchetype: "mundane_act_made_legendary", subtype: "domestic_task_mythologized" };

interface Ids {
  live: number;
  staging: number;
  approvedThenDeactivated: number;
  emptyScene: number;
  noOverride: number;
  refreshDiffers: number;
  refreshSame: number;
  candDiffers: number;
  candSame: number;
  reviewDiffers: number;
}
let ids: Ids;

async function one<T>(q: ReturnType<typeof sql>): Promise<T> {
  const r = await db.execute(q);
  return r.rows[0] as T;
}

async function insertFact(text: string, active: boolean, enrichment: unknown): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO facts (text, is_active, enrichment, enrichment_ai_derived)
    VALUES (${P + text}, ${active}, ${enrichment == null ? null : JSON.stringify(enrichment)}::jsonb,
            ${JSON.stringify(classification)}::jsonb)
    RETURNING id`)).id;
}

async function insertReview(factId: number, stage: string, status: string, approved: boolean): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO pending_reviews (submitted_text, status, workflow_stage, staging_fact_id, approved_fact_id)
    VALUES (${P + "review"}, ${status}::review_status, ${stage}::review_workflow_stage, ${factId}, ${approved ? factId : null})
    RETURNING id`)).id;
}

async function insertCandidate(factId: number, reviewId: number, override: unknown): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO fact_enrichment_versions (fact_id, version_no, status, enrichment, visual_override, source, source_review_id)
    VALUES (${factId}, 1, 'candidate', ${JSON.stringify({ ...classification, visualPromptStrategyOverride: override })}::jsonb,
            ${JSON.stringify(override)}::jsonb, 'refresh_candidate', ${reviewId})
    RETURNING id::integer AS id`)).id;
}

async function gags(factId: number) {
  const r = await db.execute(sql`SELECT * FROM fact_gags WHERE fact_id = ${factId} ORDER BY slot`);
  return r.rows as Array<Record<string, unknown>>;
}

async function enrichmentOf(factId: number) {
  return one<{ enrichment: Record<string, unknown> | null; ai: Record<string, unknown> | null }>(
    sql`SELECT enrichment, enrichment_ai_derived AS ai FROM facts WHERE id = ${factId}`);
}

async function cleanup() {
  await db.execute(sql`DELETE FROM fact_enrichment_versions WHERE fact_id IN (SELECT id FROM facts WHERE text LIKE ${P + "%"})`);
  await db.execute(sql`DELETE FROM pending_reviews WHERE submitted_text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM facts WHERE text LIKE ${P + "%"}`);
  await db.execute(sql`DELETE FROM feature_permissions_migration_log WHERE migration_name = ${LOG}`);
}

describe("migration 0139: every gag in one place", () => {
  before(async () => {
    await cleanup();
    // The pre-0139 shape: no live-fact trigger yet (the migration recreates it).
    await db.execute(sql`DROP TRIGGER IF EXISTS facts_live_requires_approved_gag ON facts`);
    await db.execute(sql`DROP TRIGGER IF EXISTS fact_gags_live_fact_keeps_approved_gag ON fact_gags`);
    await db.execute(sql`ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_enrichment_holds_no_gag`);
    await db.execute(sql`ALTER TABLE fact_enrichment_versions DROP CONSTRAINT IF EXISTS fev_open_candidate_holds_no_gag`);

    const live = await insertFact("live", true, { ...classification, visualPromptStrategyOverride: ov("{NAME} lifts the moon.") });
    const staging = await insertFact("staging", false, { ...classification, visualPromptStrategyOverride: ov("{NAME} waits.") });
    await insertReview(staging, "concept_review", "pending", false);
    const approvedThenDeactivated = await insertFact("deactivated", false, { ...classification, visualPromptStrategyOverride: ov("{NAME} rests.") });
    await insertReview(approvedThenDeactivated, "production_approved", "approved", true);
    const emptyScene = await insertFact("empty", false, { ...classification, visualPromptStrategyOverride: ov("   ") });
    const noOverride = await insertFact("none", false, classification);

    const refreshDiffers = await insertFact("refresh-differs", true, { ...classification, visualPromptStrategyOverride: ov("{NAME} old scene.") });
    const reviewDiffers = await insertReview(refreshDiffers, "concept_review", "pending", false);
    const candDiffers = await insertCandidate(refreshDiffers, reviewDiffers, ov("{NAME} new scene."));
    const sameOv = ov("{NAME} same scene.", { updatedBy: "someone", updatedAt: "2026-01-01" });
    const refreshSame = await insertFact("refresh-same", true, { ...classification, visualPromptStrategyOverride: sameOv });
    const reviewSame = await insertReview(refreshSame, "concept_review", "pending", false);
    const candSame = await insertCandidate(refreshSame, reviewSame, { ...sameOv, updatedBy: "someone else", updatedAt: "2026-02-02" });

    ids = { live, staging, approvedThenDeactivated, emptyScene, noOverride, refreshDiffers, refreshSame, candDiffers, candSame, reviewDiffers };
    await db.execute(sql.raw(MIGRATION_SQL));
  });
  after(cleanup);

  it("a live fact's gag becomes an approved, carried-over slot-1 gag, byte for byte", async () => {
    const [g, ...more] = await gags(ids.live);
    assert.equal(more.length, 0);
    assert.equal(g!["slot"], 1);
    assert.deepEqual(g!["approved_content"], ov("{NAME} lifts the moon."));
    assert.equal(g!["approved_carried_over"], true);
    assert.equal(g!["approved_example_attempt_id"], null);
    assert.equal(g!["pending_content"], null);
  });

  it("a staging fact's gag becomes pending only; a fact approved before and deactivated keeps an approved gag", async () => {
    const [s] = await gags(ids.staging);
    assert.equal(s!["approved_content"], null);
    assert.deepEqual(s!["pending_content"], ov("{NAME} waits."));
    const [d] = await gags(ids.approvedThenDeactivated);
    assert.deepEqual(d!["approved_content"], ov("{NAME} rests."));
    assert.equal(d!["approved_carried_over"], true);
  });

  it("an empty-scene override makes no gag, a fact with none is untouched, and no enrichment keeps an override", async () => {
    assert.equal((await gags(ids.emptyScene)).length, 0);
    assert.equal((await gags(ids.noOverride)).length, 0);
    for (const id of Object.values(ids).slice(0, 7)) {
      const e = await enrichmentOf(id);
      assert.ok(!e.enrichment || !("visualPromptStrategyOverride" in e.enrichment), `fact ${id} still carries an override`);
      assert.equal(e.enrichment?.["primaryArchetype"], "mundane_act_made_legendary", "the classification is kept");
    }
  });

  it("an open refresh whose gag differs becomes the gag's pending change, owned by its review; an identical one adds nothing", async () => {
    const [d] = await gags(ids.refreshDiffers);
    assert.deepEqual(d!["approved_content"], ov("{NAME} old scene."));
    assert.deepEqual(d!["pending_content"], ov("{NAME} new scene."));
    assert.equal(d!["pending_review_id"], ids.reviewDiffers);
    const [s] = await gags(ids.refreshSame);
    assert.equal(s!["pending_content"], null, "only provenance differed");
    for (const v of [ids.candDiffers, ids.candSame]) {
      const row = await one<{ visual_override: unknown; enrichment: Record<string, unknown> }>(
        sql`SELECT visual_override, enrichment FROM fact_enrichment_versions WHERE id = ${v}`);
      assert.equal(row.visual_override, null);
      assert.ok(!("visualPromptStrategyOverride" in row.enrichment));
    }
  });

  it("captures every moved override and every open candidate's, whole", async () => {
    const r = await db.execute(sql`SELECT deleted_rows FROM feature_permissions_migration_log WHERE migration_name = ${LOG}`);
    assert.equal(r.rows.length, 1);
    const log = (r.rows[0] as { deleted_rows: { facts: Array<Record<string, unknown>>; candidates: Array<Record<string, unknown>> } }).deleted_rows;
    const live = log.facts.find((f) => f["id"] === ids.live)!;
    assert.deepEqual(live["override"], ov("{NAME} lifts the moon."));
    assert.ok(log.facts.some((f) => f["id"] === ids.emptyScene), "an empty-scene override is captured too");
    assert.ok(log.candidates.some((c) => c["id"] === ids.candDiffers));
  });

  it("a second run captures nothing and changes nothing", async () => {
    const before = await db.execute(sql`SELECT * FROM fact_gags WHERE fact_id IN (SELECT id FROM facts WHERE text LIKE ${P + "%"}) ORDER BY id`);
    await db.execute(sql.raw(MIGRATION_SQL));
    const afterRun = await db.execute(sql`SELECT * FROM fact_gags WHERE fact_id IN (SELECT id FROM facts WHERE text LIKE ${P + "%"}) ORDER BY id`);
    assert.deepEqual(afterRun.rows, before.rows);
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM feature_permissions_migration_log WHERE migration_name = ${LOG}`);
    assert.equal((r.rows[0] as { n: number }).n, 1);
  });

  it("the reverse script rebuilds every prior state (run in a transaction that is rolled back)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(REVERSE_SQL);
      const f = await client.query("SELECT id, enrichment FROM facts WHERE text LIKE $1", [P + "%"]);
      const byId = new Map(f.rows.map((r: { id: number; enrichment: Record<string, unknown> }) => [r.id, r.enrichment]));
      assert.deepEqual(byId.get(ids.live)!["visualPromptStrategyOverride"], ov("{NAME} lifts the moon."));
      assert.deepEqual(byId.get(ids.staging)!["visualPromptStrategyOverride"], ov("{NAME} waits."));
      assert.deepEqual(byId.get(ids.emptyScene)!["visualPromptStrategyOverride"], ov("   "));
      assert.ok(!("visualPromptStrategyOverride" in byId.get(ids.noOverride)!));
      const c = await client.query("SELECT visual_override FROM fact_enrichment_versions WHERE id = $1", [ids.candDiffers]);
      assert.deepEqual(c.rows[0].visual_override, ov("{NAME} new scene."));
      const t = await client.query("SELECT to_regclass(quote_ident(current_schema()) || '.fact_gags') AS t");
      assert.equal(t.rows[0].t, null);
      const k = await client.query("SELECT 1 FROM pg_constraint WHERE conname = 'facts_active_requires_concept'");
      assert.equal(k.rowCount, 1, "the old CHECK is back");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("the reverse script refuses once a gag was changed under the new model", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE fact_gags SET updated_at = now() + interval '1 second' WHERE fact_id = $1", [ids.live]);
      await assert.rejects(client.query(REVERSE_SQL), /refused/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
