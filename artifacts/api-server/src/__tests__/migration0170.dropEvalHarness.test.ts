/**
 * Migration 0170 (prompt tuner plan docs/plans/PLAN_PROMPT_TUNER.md, *E.
 * Retirements*; launch Phase 8 part 4, Issue #887): the old eval harness's data
 * is dropped.
 *
 * The test database is already migrated, so what 0170 drops is put back first
 * (helpers/evalHarnessSchema.ts), with rows planted in it. Then 0170 runs twice.
 * The row-state matrix, each planted and checked:
 * - an attempt tagged with an eval run: counted; the attempt itself is kept;
 * - an attempt with a moderator rating, and one with only a failure tag:
 *   counted once each; both kept;
 * - an ordinary attempt: not counted, kept;
 * - one eval run: counted, then the table gone;
 * - afterwards the eight columns, both partial indexes and the foreign key are
 *   gone; a second run finds nothing and counts 0.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { M0170, restoreEvalHarnessSchema } from "./helpers/evalHarnessSchema.js";

const P = `t_0170_${randomUUID().slice(0, 8)}`;
const COLUMNS = ["moderator_rating", "failure_tag", "eval_notes", "eval_by", "eval_at", "eval_run_id", "eval_scenario_key", "eval_input_hash"];

const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(q)).rows as T[];
const one = async <T>(q: ReturnType<typeof sql>): Promise<T | undefined> => (await rows<T>(q))[0];
const columnExists = async (column: string): Promise<boolean> => (await rows(sql`
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'image_prompt_attempts' AND column_name = ${column}`)).length > 0;
const indexExists = async (name: string): Promise<boolean> =>
  (await rows(sql`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${name}`)).length > 0;

/** Run 0170, returning the NOTICEs it raised. */
async function run0170(): Promise<string[]> {
  const notices: string[] = [];
  const client = await pool.connect();
  const listen = (m: { message?: string }) => { if (m.message?.startsWith("[0170]")) notices.push(m.message); };
  client.on("notice", listen);
  try { await client.query(M0170); } finally { client.off("notice", listen); client.release(); }
  return notices;
}

async function attempt(factId: number, extra: ReturnType<typeof sql>): Promise<number> {
  const r = await one<{ id: number }>(sql`
    INSERT INTO image_prompt_attempts (fact_id, render_job_id, generation_mode, subject_render_mode, target_engine,
      source_image_analysis, identity_policy, render_controls, fact_enrichment_snapshot, archetype_strategy_version)
    VALUES (${factId}, ${randomUUID()}, 't2i', 't2i_fallback', 'nano_banana_2', '{}', '{}', '{}', '{}', 'v2')
    RETURNING id::integer AS id`);
  await db.execute(sql`UPDATE image_prompt_attempts SET ${extra} WHERE id = ${r!.id}`);
  return r!.id;
}

describe("migration 0170: the eval harness's data is dropped", () => {
  const ids: Record<string, number> = {};
  const notices: Record<string, string[]> = {};

  before(async () => {
    await restoreEvalHarnessSchema();
    // Count what an earlier test may have left, so this test's own rows are what it checks.
    const before = await one<{ tagged: number; rated: number; runs: number }>(sql`
      SELECT (SELECT count(*)::integer FROM image_prompt_attempts WHERE eval_run_id IS NOT NULL) AS tagged,
             (SELECT count(*)::integer FROM image_prompt_attempts WHERE moderator_rating IS NOT NULL OR failure_tag IS NOT NULL) AS rated,
             (SELECT count(*)::integer FROM eval_runs) AS runs`);
    ids.baseTagged = before!.tagged; ids.baseRated = before!.rated; ids.baseRuns = before!.runs;

    ids.fact = (await one<{ id: number }>(sql`INSERT INTO facts (text, is_active) VALUES (${`{NAME} ${P} lifts a moon`}, false) RETURNING id`))!.id;
    ids.run = (await one<{ id: number }>(sql`INSERT INTO eval_runs (label) VALUES (${P}) RETURNING id::integer AS id`))!.id;
    ids.tagged = await attempt(ids.fact, sql`eval_run_id = ${ids.run}, eval_scenario_key = 'i2i_male_default', eval_input_hash = 'h'`);
    ids.rated = await attempt(ids.fact, sql`moderator_rating = 4, eval_by = 'someone', eval_at = now(), eval_notes = 'fine'`);
    ids.tagOnly = await attempt(ids.fact, sql`failure_tag = 'compiler'`);
    ids.plain = await attempt(ids.fact, sql`error = NULL`);

    notices.first = await run0170();
    notices.second = await run0170();
  });

  it("counts what it drops, before dropping it", () => {
    assert.deepEqual(notices.first, [
      `[0170] eval harness dropped: ${ids.baseTagged! + 1} attempt(s) were tagged with an eval run, ${ids.baseRated! + 2} carried a rating or failure tag, ${ids.baseRuns! + 1} eval run(s)`,
    ]);
  });

  it("drops the eight columns, both partial indexes, the foreign key and eval_runs", async () => {
    for (const c of COLUMNS) assert.equal(await columnExists(c), false, c);
    assert.equal(await indexExists("IDX_ipa_eval_run_fact_created"), false);
    assert.equal(await indexExists("IDX_ipa_eval_fact_run_created"), false);
    assert.equal((await rows(sql`SELECT 1 FROM pg_constraint WHERE conname = 'image_prompt_attempts_eval_run_id_eval_runs_id_fk'`)).length, 0);
    assert.equal((await one<{ t: string | null }>(sql`SELECT to_regclass('eval_runs')::text AS t`))!.t, null);
  });

  it("keeps every render attempt, the eval ones included", async () => {
    for (const k of ["tagged", "rated", "tagOnly", "plain"]) {
      assert.ok(await one(sql`SELECT 1 FROM image_prompt_attempts WHERE id = ${ids[k]!}`), `${k} is kept`);
    }
  });

  it("a second run is a no-op and counts 0", () => {
    assert.deepEqual(notices.second, ["[0170] eval harness dropped: 0 attempt(s) were tagged with an eval run, 0 carried a rating or failure tag, 0 eval run(s)"]);
  });
});
