/**
 * Migration 0155 (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, Data Model;
 * Issue #1018, increment 1.2c-ii): the four moderation steps.
 *
 * The real migration file runs inside a rolled-back transaction, against a
 * scratch schema built in the shape before it (the old eight-label enum,
 * Withdraw's columns and check), first on the search path. The database the
 * other tests share is never touched.
 *
 * The row-state matrix, each planted and checked:
 * - every old stage maps as the plan's Data Model says; the three prep stages
 *   go to gags when the staging fact has an approved humor note, else reading;
 * - triage_rejected and production_rejected merge into rejected, reason kept;
 * - counts per old and per new stage are reported;
 * - Withdraw's columns and check are dropped; fact_readings and
 *   facts.humor_note_reading_id exist;
 * - a second run changes nothing (no-op, reported);
 * - a row with a label outside the map aborts the migration (failed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { PoolClient } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0155_moderation_four_steps.sql"), "utf8");

const OLD_LABELS = ["triage_pending", "triage_rejected", "prep_pending", "prep_failed", "concept_review", "production_review", "production_rejected", "production_approved"];

/** A scratch schema in the pre-0155 shape, first on the search path, inside a transaction that is rolled back. */
async function inScratch<T>(extraLabel: string | null, fn: (c: PoolClient, notices: string[]) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => { if (n.message) notices.push(n.message); };
  c.on("notice", onNotice);
  const schema = `t0155_${randomUUID().slice(0, 8)}`;
  try {
    await c.query("BEGIN");
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET LOCAL search_path TO ${schema}, public`);
    const labels = [...OLD_LABELS, ...(extraLabel ? [extraLabel] : [])].map((l) => `'${l}'`).join(", ");
    await c.query(`
      CREATE TABLE users (id varchar PRIMARY KEY);
      CREATE TYPE review_workflow_stage AS ENUM (${labels});
      CREATE TABLE facts (
        id serial PRIMARY KEY,
        is_active boolean NOT NULL DEFAULT false,
        humor_note_approved_at timestamptz,
        wording_withdrawn_at timestamptz,
        CONSTRAINT facts_withdrawn_stays_inactive CHECK (NOT (is_active AND wording_withdrawn_at IS NOT NULL))
      );
      CREATE TABLE pending_reviews (
        id serial PRIMARY KEY,
        status text NOT NULL DEFAULT 'pending',
        workflow_stage review_workflow_stage NOT NULL DEFAULT 'triage_pending',
        staging_fact_id integer REFERENCES facts(id),
        reason text,
        withdrawn_at timestamptz,
        withdrawn_by varchar REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_pending_reviews_workflow_stage ON pending_reviews (workflow_stage);
    `);
    return await fn(c, notices);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.off("notice", onNotice);
    c.release();
  }
}

async function fact(c: PoolClient, noted: boolean): Promise<number> {
  const r = await c.query<{ id: number }>(`INSERT INTO facts (humor_note_approved_at) VALUES (${noted ? "now()" : "NULL"}) RETURNING id`);
  return r.rows[0]!.id;
}
async function review(c: PoolClient, stage: string, opts: { factId?: number | null; status?: string; reason?: string | null } = {}): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO pending_reviews (status, workflow_stage, staging_fact_id, reason) VALUES ($1, $2::review_workflow_stage, $3, $4) RETURNING id`,
    [opts.status ?? "pending", stage, opts.factId ?? null, opts.reason ?? null],
  );
  return r.rows[0]!.id;
}
const stageOf = async (c: PoolClient, id: number) => (await c.query<{ s: string; reason: string | null }>(`SELECT workflow_stage::text AS s, reason FROM pending_reviews WHERE id = $1`, [id])).rows[0]!;

describe("migration 0155: the four moderation steps", () => {
  it("maps every old stage, merges the rejected stages, reports counts, and drops Withdraw's columns and check", async () => {
    await inScratch(null, async (c, notices) => {
      const ids: Record<string, number> = {};
      ids.triage = await review(c, "triage_pending");
      ids.prepNoNote = await review(c, "prep_pending", { factId: await fact(c, false) });
      ids.failedNoNote = await review(c, "prep_failed", { factId: await fact(c, false) });
      ids.conceptNoNote = await review(c, "concept_review", { factId: await fact(c, false) });
      ids.conceptNoted = await review(c, "concept_review", { factId: await fact(c, true) });
      ids.prepNoted = await review(c, "prep_pending", { factId: await fact(c, true) });
      ids.production = await review(c, "production_review", { factId: await fact(c, true) });
      ids.approved = await review(c, "production_approved", { factId: await fact(c, true), status: "approved" });
      ids.triageRejected = await review(c, "triage_rejected", { status: "rejected", reason: "spam" });
      ids.productionRejected = await review(c, "production_rejected", { factId: await fact(c, false), status: "rejected", reason: "visual" });

      await c.query(MIGRATION_SQL);

      const expect: Record<string, string> = {
        triage: "triage", prepNoNote: "reading", failedNoNote: "reading", conceptNoNote: "reading",
        conceptNoted: "gags", prepNoted: "gags", production: "test_renders", approved: "approved",
        triageRejected: "rejected", productionRejected: "rejected",
      };
      for (const [k, want] of Object.entries(expect)) assert.equal((await stageOf(c, ids[k]!)).s, want, k);
      assert.equal((await stageOf(c, ids.triageRejected!)).reason, "spam", "the reason is kept");
      assert.equal((await stageOf(c, ids.productionRejected!)).reason, "visual");

      const labels = (await c.query<{ l: string }>(`SELECT unnest(enum_range(NULL::review_workflow_stage))::text AS l`)).rows.map((r) => r.l);
      assert.deepEqual(labels, ["triage", "reading", "gags", "test_renders", "approved", "rejected"]);
      const def = (await c.query<{ d: string }>(`SELECT column_default AS d FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pending_reviews' AND column_name = 'workflow_stage'`)).rows[0]!.d;
      assert.match(def, /'triage'/);

      const cols = async (table: string) => (await c.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table])).rows.map((r) => r.c);
      assert.equal((await cols("pending_reviews")).includes("withdrawn_at"), false);
      assert.equal((await cols("pending_reviews")).includes("withdrawn_by"), false);
      assert.equal((await cols("facts")).includes("wording_withdrawn_at"), false);
      assert.equal((await cols("facts")).includes("humor_note_reading_id"), true);
      assert.ok((await cols("fact_readings")).includes("draft_note"));
      const check = await c.query(`SELECT 1 FROM pg_constraint WHERE conname = 'facts_withdrawn_stays_inactive' AND connamespace = current_schema()::regnamespace`);
      assert.equal(check.rowCount, 0, "the Withdraw check is dropped");

      const report = notices.find((n) => n.startsWith("0155_moderation_four_steps: before"));
      assert.ok(report, notices.join(" | "));
      assert.match(report!, /before \[.*concept_review=2.*prep_pending=2.*\]; after \[.*gags=2.*reading=3.*rejected=2.*\]/);

      // A second run changes nothing.
      const before = (await c.query(`SELECT id, workflow_stage::text AS s FROM pending_reviews ORDER BY id`)).rows;
      await c.query(MIGRATION_SQL);
      assert.deepEqual((await c.query(`SELECT id, workflow_stage::text AS s FROM pending_reviews ORDER BY id`)).rows, before);
      assert.ok(notices.some((n) => n.includes("stages already recast; no-op")));
    });
  });

  it("aborts, naming the label, when a row carries a stage outside the map", async () => {
    await inScratch("mystery_stage", async (c) => {
      await review(c, "mystery_stage");
      await assert.rejects(c.query(MIGRATION_SQL), /unmapped stages: mystery_stage/);
    });
  });
});
