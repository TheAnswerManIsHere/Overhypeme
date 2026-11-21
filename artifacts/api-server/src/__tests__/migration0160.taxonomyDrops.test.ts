/**
 * Migration 0160 (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 15,
 * 2A/2B; Issue #1018, increment 2.1c): each fact's taxonomy is kept in its run
 * history, then the override, signature, projection and version machinery is
 * dropped.
 *
 * The row-state matrix, each planted and checked:
 * - a fact with a taxonomy and no history: seeded, one `legacy_current` row
 *   whose output is its taxonomy;
 * - a fact whose newest stored run is exactly its taxonomy: already held, no
 *   row added;
 * - a fact whose newest stored run differs from its taxonomy (the taxonomy an
 *   override made): seeded;
 * - a fact with no taxonomy: skipped, no row;
 * - a second run: nothing new (already held, counted);
 * - a taxonomy that is not a JSON object: the migration aborts and names it;
 * - jobs on the three removed queues and a review-keyed taxonomy job: deleted;
 *   a fact's taxonomy job: kept;
 * - the columns, tables and the engine_revision setting: gone, and counted.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";
import { restorePre0160Schema } from "./helpers/pre0160Schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0160_taxonomy_drops.sql"), "utf8");
const P = `t_0160_${randomUUID().slice(0, 8)}`;

type RunRow = { origin: string; outcome: string; output: Record<string, unknown> | null; legacy: string | null };
const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(q)).rows as T[];
const one = async <T>(q: ReturnType<typeof sql>): Promise<T | undefined> => (await rows<T>(q))[0];

async function fact(label: string, taxonomy: unknown): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO facts (text, is_active, enrichment)
    VALUES (${`{NAME} ${P} ${label}`}, false, ${taxonomy === null ? null : JSON.stringify(taxonomy)}::jsonb) RETURNING id`);
  return r!.id;
}
async function run(factId: number, output: unknown, createdAt: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO fact_taxonomy_runs (fact_id, outcome, origin, output, created_at)
    VALUES (${factId}, 'ok', 'rerun', ${JSON.stringify(output)}::jsonb, ${createdAt}::timestamptz)`);
}
async function job(queue: string, payload: Record<string, unknown>): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO async_jobs (queue, payload, status) VALUES (${queue}, ${JSON.stringify(payload)}::jsonb, 'pending') RETURNING id`);
  return r!.id;
}
const runsOf = (factId: number) => rows<RunRow>(sql`
  SELECT origin, outcome, output, legacy_version_id::text AS legacy FROM fact_taxonomy_runs WHERE fact_id = ${factId} ORDER BY id`);
const exists = async (table: string, column?: string): Promise<boolean> => (await rows(sql`
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = ${table} ${column ? sql`AND column_name = ${column}` : sql``}`)).length > 0;

async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = await pool.connect();
  client.on("notice", (m) => { if (m.message?.startsWith("[0160]")) notices.push(m.message); });
  try { await client.query(MIGRATION_SQL); } finally { client.release(); }
  return notices;
}

describe("migration 0160: today's taxonomy into history, then the taxonomy drops", () => {
  const taxonomy = { ...buildPlaceholderFactEnrichment(), adminReviewNotes: `${P} today` };
  const older = { ...buildPlaceholderFactEnrichment(), adminReviewNotes: `${P} older` };
  const f: Record<string, number> = {};
  const j: Record<string, number> = {};
  let first: string[] = [];
  let second: string[] = [];
  before(async () => {
    // The schema 0160 runs against: what it drops, put back (with the two
    // tables the helper does not need elsewhere), and the setting it deletes.
    await restorePre0160Schema();
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS enrichment_override_history (id bigserial PRIMARY KEY, fact_id integer REFERENCES facts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS engine_revision_bumps (id serial PRIMARY KEY);
      INSERT INTO engine_revision_bumps DEFAULT VALUES;
      INSERT INTO admin_config (key, value, data_type, label) VALUES ('engine_revision', '3', 'integer', 'Engine Revision')
        ON CONFLICT (key) DO NOTHING;
    `));
    f.unheld = await fact("unheld", taxonomy);
    f.held = await fact("held", taxonomy);
    await run(f.held, older, "2026-01-01T00:00:00Z");
    await run(f.held, taxonomy, "2026-02-01T00:00:00Z");
    f.overridden = await fact("overridden", taxonomy);
    await run(f.overridden, older, "2026-02-01T00:00:00Z");
    f.none = await fact("none", null);
    await db.execute(sql`UPDATE facts SET enrichment_overrides = '{"/overhypeFit":{}}'::jsonb, last_processed_signature = '{}'::jsonb, primary_archetype = 'x' WHERE id = ${f.overridden}`);
    await db.execute(sql`INSERT INTO fact_enrichment_versions (fact_id, version_no, status, source) VALUES (${f.held}, 1, 'promoted', 'prior_active_snapshot')`);
    await db.execute(sql`INSERT INTO enrichment_override_history (fact_id) VALUES (${f.overridden})`);
    j.backfill = await job("fact_enrichment_backfill", { factId: f.unheld });
    j.fill = await job("fact_character_fill", { factId: f.unheld });
    j.repair = await job("projection_repair", {});
    j.review = await job("enrichment", { reviewId: 1 });
    j.fact = await job("enrichment", { factId: f.unheld, origin: "rerun" });
    first = await runMigration();
    second = await runMigration();
  });
  after(async () => {
    await db.execute(sql`DELETE FROM async_jobs WHERE id = ${j.fact}`);
    await db.execute(sql`DELETE FROM facts WHERE text LIKE ${`%${P}%`}`); // cascades to the history
  });

  it("seeds a fact with no history from its taxonomy", async () => {
    const r = await runsOf(f.unheld!);
    assert.equal(r.length, 1);
    assert.deepEqual([r[0]!.origin, r[0]!.outcome, r[0]!.legacy], ["legacy_current", "ok", null]);
    assert.deepEqual(r[0]!.output, taxonomy);
  });

  it("adds nothing when the fact's newest stored run already is its taxonomy", async () => {
    assert.deepEqual((await runsOf(f.held!)).map((r) => r.origin), ["rerun", "rerun"]);
  });

  it("seeds a fact whose newest stored run differs from its taxonomy", async () => {
    const r = await runsOf(f.overridden!);
    assert.deepEqual(r.map((x) => x.origin), ["rerun", "legacy_current"]);
    assert.deepEqual(r[1]!.output, taxonomy);
  });

  it("skips a fact with no taxonomy, and counts every state", async () => {
    assert.deepEqual(await runsOf(f.none!), []);
    assert.match(first[0]!, /seeded into history [2-9]\d*, already held \(no-op\) [1-9]\d*, skipped \(no taxonomy\) [1-9]\d*, failed 0/);
  });

  it("a second run seeds nothing new", async () => {
    assert.match(second[0]!, /seeded into history 0, already held \(no-op\) ([3-9]|\d{2,})/);
    for (const k of ["unheld", "overridden"]) assert.equal((await runsOf(f[k]!)).length, k === "unheld" ? 1 : 2, k);
  });

  it("deletes the removed queues' jobs and a review-keyed taxonomy job, and keeps a fact's", async () => {
    const left = await rows<{ id: number }>(sql`SELECT id FROM async_jobs WHERE id IN (${j.backfill}, ${j.fill}, ${j.repair}, ${j.review}, ${j.fact})`);
    assert.deepEqual(left.map((r) => r.id), [j.fact]);
    for (const q of ["enrichment/pending 1", "fact_character_fill/pending 1", "fact_enrichment_backfill/pending 1", "projection_repair/pending 1"]) {
      assert.ok(first[1]!.includes(q), `${q} in: ${first[1]}`);
    }
    assert.equal(second[1], "[0160] jobs deleted: none");
  });

  it("drops the columns, the tables and the setting, counting what went", async () => {
    for (const c of ["enrichment_overrides", "enrichment_baseline_changed", "last_processed_signature", "primary_archetype", "subtype", "overhype_fit", "adult_suitability"]) {
      assert.equal(await exists("facts", c), false, c);
    }
    for (const t of ["fact_enrichment_versions", "enrichment_override_history", "engine_revision_bumps"]) assert.equal(await exists(t), false, t);
    assert.equal(await one(sql`SELECT 1 FROM admin_config WHERE key = 'engine_revision'`), undefined);
    assert.match(first[2]!, /override or baseline flag [1-9]\d*, with a signature [1-9]\d*, with a projection value [1-9]\d*; enrichment versions [1-9]\d*, override history rows [1-9]\d*, engine revision bumps [1-9]\d*; engine_revision config rows 1/);
    assert.match(second[2]!, /enrichment versions 0, override history rows 0, engine revision bumps 0; engine_revision config rows 0/);
  });

  it("aborts on a taxonomy that is not a JSON object, naming the fact, and changes nothing", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [bad] } = await client.query<{ id: number }>(
        `INSERT INTO facts (text, is_active, enrichment) VALUES ($1, false, '"text"'::jsonb) RETURNING id`, [`{NAME} ${P} bad`]);
      await assert.rejects(client.query(MIGRATION_SQL), new RegExp(`not a JSON object, not seeded: .*\\b${bad!.id}\\b`));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
