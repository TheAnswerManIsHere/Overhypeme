/**
 * Migration 0157 (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1F and the
 * Data Model; Issue #1018, increment 1.3a): a fact's published and draft gag
 * sets, and the removal of Draft more gags on a live fact.
 *
 * The real migration file runs inside a rolled-back transaction, against a
 * scratch schema built in the shape before it, first on the search path. The
 * database the other tests share is never touched.
 *
 * The row-state matrix, each planted and checked:
 * - a never-approved fact's gag with approved content and no draft: the
 *   approved version and its examples become the draft;
 * - a never-approved fact's gag with approved content and a draft: the
 *   approved examples are deleted, the draft kept, the approved version cleared;
 * - a never-approved fact's draft-only gag, an ever-approved fact's gags and a
 *   removed gag: untouched;
 * - a live fact with no approval on record aborts the migration (failed);
 * - a live draft's job, ownership mark and stored ideas are cleared; a
 *   review's are kept;
 * - the counts are reported, and a second run changes nothing (no-op).
 * Then the two rules it adds: published content needs an approved fact (at
 * commit), and only a published gag with no draft change is removed in the draft.
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
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0157_published_and_draft_gags.sql"), "utf8");

/** A scratch schema in the pre-0157 shape, first on the search path, inside a transaction that is rolled back. */
async function inScratch<T>(fn: (c: PoolClient, notices: string[]) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => { if (n.message) notices.push(n.message); };
  c.on("notice", onNotice);
  const schema = `t0157_${randomUUID().slice(0, 8)}`;
  try {
    await c.query("BEGIN");
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET LOCAL search_path TO ${schema}, public`);
    await c.query(`
      CREATE TABLE facts (
        id serial PRIMARY KEY,
        is_active boolean NOT NULL DEFAULT false,
        approved_at timestamptz,
        visual_concept_owner text,
        visual_concept_status text,
        visual_concept_candidates jsonb
      );
      CREATE TABLE fact_gags (
        id bigserial PRIMARY KEY,
        fact_id integer NOT NULL REFERENCES facts(id),
        slot smallint NOT NULL,
        approved_content jsonb,
        approved_by varchar,
        approved_at timestamptz,
        approved_before_example_sets boolean NOT NULL DEFAULT false,
        approved_carried_over boolean NOT NULL DEFAULT false,
        pending_content jsonb,
        pending_by varchar,
        pending_at timestamptz,
        removed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fact_gags_has_a_version CHECK (removed_at IS NOT NULL OR approved_content IS NOT NULL OR pending_content IS NOT NULL)
      );
      CREATE TABLE fact_gag_examples (
        id bigserial PRIMARY KEY,
        gag_id bigint NOT NULL REFERENCES fact_gags(id),
        subject_kind varchar(16) NOT NULL,
        stage varchar(16) NOT NULL,
        attempt_id bigint NOT NULL
      );
      CREATE TABLE async_jobs (id serial PRIMARY KEY, queue text NOT NULL, payload jsonb, status text NOT NULL DEFAULT 'pending');
    `);
    return await fn(c, notices);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.off("notice", onNotice);
    c.release();
  }
}

const A = JSON.stringify({ coreSceneOverride: "{NAME} the approved version." });
const D = JSON.stringify({ coreSceneOverride: "{NAME} the draft." });

async function fact(c: PoolClient, opts: { approved?: boolean; active?: boolean } = {}): Promise<number> {
  const r = await c.query<{ id: number }>(
    "INSERT INTO facts (is_active, approved_at) VALUES ($1, $2) RETURNING id",
    [opts.active ?? false, opts.approved ? new Date() : null],
  );
  return r.rows[0]!.id;
}
async function gag(c: PoolClient, factId: number, slot: number, v: { approved?: string; pending?: string; removed?: boolean; carried?: boolean }): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO fact_gags (fact_id, slot, approved_content, approved_by, approved_at, approved_carried_over, pending_content, removed_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8) RETURNING id::integer AS id`,
    [factId, slot, v.approved ?? null, v.approved ? "admin-1" : null, v.approved ? new Date() : null, v.carried ?? false, v.pending ?? null, v.removed ? new Date() : null],
  );
  return r.rows[0]!.id;
}
async function examples(c: PoolClient, gagId: number, stage: string, kinds = ["male", "female", "pet"]): Promise<void> {
  for (const [i, k] of kinds.entries()) {
    await c.query("INSERT INTO fact_gag_examples (gag_id, subject_kind, stage, attempt_id) VALUES ($1, $2, $3, $4)", [gagId, k, stage, gagId * 100 + i]);
  }
}
const row = async (c: PoolClient, id: number) => (await c.query(
  "SELECT approved_content, approved_by, approved_carried_over, pending_content, pending_by, removed_at FROM fact_gags WHERE id = $1", [id],
)).rows[0]!;
const stages = async (c: PoolClient, id: number) => (await c.query<{ stage: string; n: number }>(
  "SELECT stage, count(*)::int AS n FROM fact_gag_examples WHERE gag_id = $1 GROUP BY stage ORDER BY stage", [id],
)).rows.map((r) => `${r.stage}=${r.n}`);

describe("migration 0157: published and draft gag sets", () => {
  it("moves a never-approved fact's approved versions into the draft, leaves everything else, clears Draft more gags, and is a no-op on a second run", async () => {
    await inScratch(async (c, notices) => {
      const unapproved = await fact(c);
      const toDraft = await gag(c, unapproved, 1, { approved: A, carried: true });
      await examples(c, toDraft, "approved");
      const superseded = await gag(c, unapproved, 2, { approved: A, pending: D });
      await examples(c, superseded, "approved");
      await examples(c, superseded, "pending", ["male"]);
      const draftOnly = await gag(c, unapproved, 3, { pending: D });
      const removedUnapproved = await gag(c, await fact(c), 1, { approved: A, removed: true });

      const live = await fact(c, { approved: true, active: true });
      const published = await gag(c, live, 1, { approved: A });
      await examples(c, published, "approved");
      const publishedWithChange = await gag(c, live, 2, { approved: A, pending: D });
      await examples(c, publishedWithChange, "pending", ["male"]);

      // Draft more gags: a live draft's job, mark and ideas; a review's are kept.
      const liveDrafted = await fact(c, { approved: true, active: true });
      await gag(c, liveDrafted, 1, { approved: A });
      await c.query("UPDATE facts SET visual_concept_owner = 'live:abc', visual_concept_status = 'pending', visual_concept_candidates = $2::jsonb WHERE id = $1",
        [liveDrafted, JSON.stringify({ source: "live_fact", reviewId: null, candidates: [] })]);
      const reviewed = await fact(c);
      await c.query("UPDATE facts SET visual_concept_owner = 'review:9:x', visual_concept_status = 'ok', visual_concept_candidates = $2::jsonb WHERE id = $1",
        [reviewed, JSON.stringify({ source: "staging_fact", reviewId: 9, candidates: [] })]);
      await c.query(`INSERT INTO async_jobs (queue, payload) VALUES
        ('fact_visual_concepts', '{"reviewId": null, "factId": 1}'),
        ('fact_visual_concepts', '{"factId": 1}'),
        ('fact_visual_concepts', '{"reviewId": 9, "factId": 2}'),
        ('enrichment', '{"factId": 3}')`);

      await c.query(MIGRATION_SQL);

      const a = await row(c, toDraft);
      assert.equal(a.approved_content, null, "a: the approved version is cleared");
      assert.equal(a.approved_by, null);
      assert.equal(a.approved_carried_over, false);
      assert.deepEqual(a.pending_content, JSON.parse(A), "a: it is the draft now");
      assert.equal(a.pending_by, "admin-1", "a: who approved it is who made the draft");
      assert.deepEqual(await stages(c, toDraft), ["pending=3"], "a: its examples are the draft's picks");

      const b = await row(c, superseded);
      assert.equal(b.approved_content, null, "b: the approved version is cleared");
      assert.deepEqual(b.pending_content, JSON.parse(D), "b: the draft is kept");
      assert.deepEqual(await stages(c, superseded), ["pending=1"], "b: the older approved examples are gone, the draft's pick kept");

      assert.deepEqual((await row(c, draftOnly)).pending_content, JSON.parse(D), "draft-only: untouched");
      assert.deepEqual((await row(c, removedUnapproved)).approved_content, JSON.parse(A), "removed: skipped");
      assert.deepEqual((await row(c, published)).approved_content, JSON.parse(A), "ever-approved: untouched");
      assert.deepEqual(await stages(c, published), ["approved=3"]);
      const pc = await row(c, publishedWithChange);
      assert.deepEqual([pc.approved_content, pc.pending_content], [JSON.parse(A), JSON.parse(D)], "ever-approved with a change: untouched");

      const facts = (await c.query("SELECT id, visual_concept_owner AS o, visual_concept_status AS s, visual_concept_candidates AS v FROM facts WHERE id = ANY($1) ORDER BY id", [[liveDrafted, reviewed]])).rows;
      assert.deepEqual(facts[0], { id: liveDrafted, o: null, s: null, v: null }, "a live draft's state is cleared");
      assert.equal(facts[1].o, "review:9:x", "a review's state is kept");
      assert.notEqual(facts[1].v, null);
      const jobs = (await c.query<{ queue: string; payload: { reviewId?: number } }>("SELECT queue, payload FROM async_jobs ORDER BY id")).rows;
      assert.deepEqual(jobs.map((j) => [j.queue, j.payload.reviewId ?? null]), [["fact_visual_concepts", 9], ["enrichment", null]], "only the live drafts' jobs are deleted");

      const report = notices.find((n) => n.startsWith("0157_published_and_draft_gags: "));
      assert.ok(report, notices.join(" | "));
      assert.match(report!, /untouched 3; never-approved facts: approved version moved to the draft 1, superseded by a draft 1, draft only \(no-op\) 1; examples moved to the draft 3, superseded examples deleted 3; removed gags skipped 1/);
      assert.ok(notices.some((n) => /live-draft jobs deleted 2, ownership marks cleared 1, stored live ideas cleared 1/.test(n)), notices.join(" | "));

      // A second run changes nothing.
      const snapshot = async () => (await c.query("SELECT id, approved_content, pending_content, removed_at FROM fact_gags ORDER BY id")).rows;
      const before = await snapshot();
      await c.query(MIGRATION_SQL);
      assert.deepEqual(await snapshot(), before);
      assert.ok(notices.filter((n) => n.startsWith("0157_published_and_draft_gags: ")).at(-1)!.includes("moved to the draft 0, superseded by a draft 0"));
    });
  });

  it("aborts, naming the fact, when a live fact has no approval on record", async () => {
    await inScratch(async (c) => {
      const id = await fact(c, { active: true });
      await assert.rejects(c.query(MIGRATION_SQL), new RegExp(`live facts with no approval on record \\(ids: ${id}\\)`));
    });
  });

  it("then refuses published content on a never-approved fact at commit, and a draft removal of anything but an unchanged published gag", async () => {
    await inScratch(async (c) => {
      await c.query(MIGRATION_SQL);
      // The migration sets its transaction's checks immediate; a real
      // transaction after it starts deferred.
      await c.query("SET CONSTRAINTS ALL DEFERRED");
      const unapproved = await fact(c);
      await c.query("SAVEPOINT s1");
      await gag(c, unapproved, 1, { approved: A });
      await assert.rejects(c.query("SET CONSTRAINTS ALL IMMEDIATE"), /never approved for production/);
      await c.query("ROLLBACK TO SAVEPOINT s1");

      const approved = await fact(c, { approved: true });
      const id = await gag(c, approved, 1, { approved: A });
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      await c.query("UPDATE fact_gags SET draft_removed = true WHERE id = $1", [id]);
      await c.query("SAVEPOINT s2");
      await assert.rejects(c.query("UPDATE fact_gags SET pending_content = $2::jsonb WHERE id = $1", [id, D]), /fact_gags_draft_removed_is_published/);
      await c.query("ROLLBACK TO SAVEPOINT s2");
      await assert.rejects(c.query("INSERT INTO fact_gags (fact_id, slot, pending_content, draft_removed) VALUES ($1, 2, $2::jsonb, true)", [approved, D]), /fact_gags_draft_removed_is_published/);
    });
  });
});
