/**
 * Migrations 0167–0169 (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 23;
 * Issue #1018, increment 3.2e): fact administration's drops.
 *
 * The test database is already migrated, so what the three drop is put back
 * first, in the shape the baseline gave it, with rows planted in it. Then each
 * migration runs twice. The row-state matrix, each planted and checked:
 * - 0167: an edit-history row: counted, then the table gone; a second run
 *   finds the table absent and says so;
 * - 0168: a golden fact with a reason and a golden fact without one: counted,
 *   then the partial index and both columns gone; a second run counts 0;
 * - 0169: jobs on the retired backfill queue (pending and failed): deleted and
 *   counted by status; a job on another queue: kept; a fact holding scene
 *   prompts and one holding a backfill status: counted, then both columns
 *   gone; facts.ai_meme_images is kept with its value; a second run deletes
 *   nothing and counts 0.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (tag: string) =>
  readFileSync(path.resolve(__dirname, `../../../../lib/db/migrations/${tag}.sql`), "utf8");
const M0167 = migration("0167_drop_fact_text_edit_history");
const M0168 = migration("0168_drop_eval_golden");
const M0169 = migration("0169_drop_legacy_ai_meme_columns");

const P = `t_0167_${randomUUID().slice(0, 8)}`;

const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(q)).rows as T[];
const one = async <T>(q: ReturnType<typeof sql>): Promise<T | undefined> => (await rows<T>(q))[0];
const exists = async (table: string, column?: string): Promise<boolean> => (await rows(sql`
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = ${table} ${column ? sql`AND column_name = ${column}` : sql``}`)).length > 0;
const indexExists = async (name: string): Promise<boolean> =>
  (await rows(sql`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${name}`)).length > 0;

/** Run one migration, returning the NOTICEs it raised. */
async function runMigration(text: string, tag: string): Promise<string[]> {
  const notices: string[] = [];
  const client = await pool.connect();
  // The pool hands the same connection back, so the listener goes with the run.
  const listen = (m: { message?: string }) => { if (m.message?.startsWith(`[${tag}]`)) notices.push(m.message); };
  client.on("notice", listen);
  try { await client.query(text); } finally { client.off("notice", listen); client.release(); }
  return notices;
}

/** Put back what 0167–0169 drop, as the baseline declared it. Idempotent. */
async function restorePre0167Schema(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS fact_text_edit_history (
      id bigserial PRIMARY KEY,
      fact_id integer NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      old_text text NOT NULL,
      new_text text NOT NULL,
      reason text NOT NULL,
      performed_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "IDX_fteh_fact_created" ON fact_text_edit_history (fact_id, created_at DESC);
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS eval_golden boolean NOT NULL DEFAULT false;
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS eval_golden_reason text;
    CREATE INDEX IF NOT EXISTS "IDX_facts_eval_golden" ON facts (id) WHERE eval_golden;
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS ai_scene_prompts jsonb;
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS ai_meme_backfill_status varchar(16);
  `));
}

async function fact(label: string): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO facts (text, is_active) VALUES (${`{NAME} ${P} ${label}`}, false) RETURNING id`);
  return r!.id;
}
async function job(queue: string, status: string): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO async_jobs (queue, payload, status) VALUES (${queue}, ${JSON.stringify({ factId: 0, p: P })}::jsonb, ${status}) RETURNING id`);
  return r!.id;
}

describe("migrations 0167–0169: fact administration's drops", () => {
  const f: Record<string, number> = {};
  const j: Record<string, number> = {};
  const n: Record<string, string[]> = {};
  const images = { male: [`/objects/${P}/m.png`], female: [], neutral: [] };

  before(async () => {
    await restorePre0167Schema();
    f.edited = await fact("edited");
    f.golden = await fact("golden");
    f.goldenNoReason = await fact("golden-no-reason");
    f.prompts = await fact("prompts");
    f.status = await fact("status");
    await db.execute(sql.raw(`
      INSERT INTO fact_text_edit_history (fact_id, old_text, new_text, reason)
        VALUES (${f.edited}, 'old', 'new', 'a reason long enough');
      UPDATE facts SET eval_golden = true, eval_golden_reason = 'why' WHERE id = ${f.golden};
      UPDATE facts SET eval_golden = true WHERE id = ${f.goldenNoReason};
      UPDATE facts SET ai_scene_prompts = '{"fact_type":"action","male":"m","female":"f","neutral":""}'::jsonb,
                       ai_meme_images = '${JSON.stringify(images)}'::jsonb
        WHERE id = ${f.prompts};
      UPDATE facts SET ai_meme_backfill_status = 'ok' WHERE id = ${f.status};
    `));
    j.pending = await job("fact_ai_meme_backfill", "pending");
    j.failed = await job("fact_ai_meme_backfill", "failed");
    j.other = await job("enrichment", "pending");

    for (const [k, text, tag] of [["0167", M0167, "0167"], ["0168", M0168, "0168"], ["0169", M0169, "0169"]] as const) {
      n[`${k}a`] = await runMigration(text, tag);
      n[`${k}b`] = await runMigration(text, tag);
    }
  });

  it("0167 counts the edit history and drops the table; a second run is a no-op", async () => {
    assert.match(n["0167a"]![0]!, /^\[0167\] fact_text_edit_history dropped: 1 row\(s\)$/);
    assert.equal(await exists("fact_text_edit_history"), false);
    assert.equal(await indexExists("IDX_fteh_fact_created"), false);
    assert.deepEqual(n["0167b"], ["[0167] fact_text_edit_history absent: no-op"]);
    assert.ok(await one(sql`SELECT 1 FROM facts WHERE id = ${f.edited}`), "the edited fact itself stays");
  });

  it("0168 counts the golden marks and drops the index and both columns; a second run counts 0", async () => {
    // The columns were put back empty, so the two planted facts are the only golden ones.
    assert.deepEqual(n["0168a"], ["[0168] eval_golden dropped: 2 fact(s) were marked golden, 1 had a reason"]);
    assert.equal(await indexExists("IDX_facts_eval_golden"), false);
    for (const c of ["eval_golden", "eval_golden_reason"]) assert.equal(await exists("facts", c), false, c);
    assert.deepEqual(n["0168b"], ["[0168] eval_golden dropped: 0 fact(s) were marked golden, 0 had a reason"]);
  });

  it("0169 deletes the retired queue's jobs by status and keeps every other queue's", async () => {
    const left = await rows<{ id: number }>(sql`SELECT id FROM async_jobs WHERE id IN (${j.pending}, ${j.failed}, ${j.other})`);
    assert.deepEqual(left.map((r) => r.id), [j.other]);
    assert.match(n["0169a"]![0]!, /^\[0169\] fact_ai_meme_backfill jobs deleted: failed [1-9]\d*, pending [1-9]\d*;/);
    assert.match(n["0169b"]![0]!, /^\[0169\] fact_ai_meme_backfill jobs deleted: none;/);
  });

  it("0169 counts and drops the scene prompts and the backfill status, and keeps the stored pictures", async () => {
    assert.match(n["0169a"]![0]!, /dropped ai_scene_prompts \(1 fact\(s\) held one\) and ai_meme_backfill_status \(1 fact\(s\) held one\)$/);
    for (const c of ["ai_scene_prompts", "ai_meme_backfill_status"]) assert.equal(await exists("facts", c), false, c);
    assert.match(n["0169b"]![0]!, /dropped ai_scene_prompts \(0 fact\(s\) held one\) and ai_meme_backfill_status \(0 fact\(s\) held one\)$/);
    const kept = await one<{ images: unknown }>(sql`SELECT ai_meme_images AS images FROM facts WHERE id = ${f.prompts}`);
    assert.deepEqual(kept!.images, images);
  });
});
