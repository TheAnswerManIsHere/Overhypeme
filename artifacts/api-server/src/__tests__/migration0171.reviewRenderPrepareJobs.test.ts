/**
 * Migration 0171 (plan docs/plans/PLAN_RENDERS_MANUAL.md, D2; Issue #1282):
 * the retired automatic-render queue's jobs are deleted.
 *
 * The row-state matrix, each planted and checked:
 * - jobs on review_render_scenarios_prepare (pending, running, done, failed):
 *   deleted, and counted by status in the NOTICE;
 * - a job on another queue: kept;
 * - a second run: deletes nothing and says "none".
 * The rehearsal's loss accounting counts the same rows before the migration
 * runs, so the deletion reads as intended (reviewRenderPrepareDropLosses).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { reviewRenderPrepareDropLosses } from "../lib/retirementLosses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const M0171 = readFileSync(path.resolve(__dirname, "../../../../lib/db/migrations/0171_drop_review_render_prepare_jobs.sql"), "utf8");
const QUEUE = "review_render_scenarios_prepare";
const P = `t_0171_${randomUUID().slice(0, 8)}`;

const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(q)).rows as T[];

/** Run the migration, returning the NOTICEs it raised. */
async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = await pool.connect();
  // The pool hands the same connection back, so the listener goes with the run.
  const listen = (m: { message?: string }) => { if (m.message?.startsWith("[0171]")) notices.push(m.message); };
  client.on("notice", listen);
  try { await client.query(M0171); } finally { client.off("notice", listen); client.release(); }
  return notices;
}

async function job(queue: string, status: string): Promise<number> {
  const [r] = await rows<{ id: number }>(sql`
    INSERT INTO async_jobs (queue, payload, status) VALUES (${queue}, ${JSON.stringify({ gagId: 0, p: P })}::jsonb, ${status}) RETURNING id`);
  return r!.id;
}

describe("migration 0171: the retired automatic-render queue's jobs", () => {
  it("deletes every job on the queue whatever its status, counts them by status, keeps other queues, and a re-run deletes nothing", async () => {
    // Any job a previous run left on the queue would change the counts; clear it first.
    await db.execute(sql`DELETE FROM async_jobs WHERE queue = ${QUEUE}`);
    const planted = [await job(QUEUE, "pending"), await job(QUEUE, "pending"), await job(QUEUE, "running"), await job(QUEUE, "done"), await job(QUEUE, "failed")];
    const other = await job("gag_prefill", "pending");
    try {
      const client = await pool.connect();
      try {
        assert.deepEqual([...(await reviewRenderPrepareDropLosses(client)).entries()], [["async_jobs", 5]], "the rehearsal counts the same rows as intended");
      } finally { client.release(); }

      assert.deepEqual(await runMigration(), ["[0171] review_render_scenarios_prepare jobs deleted: done 1, failed 1, pending 2, running 1"]);
      const left = await rows<{ id: number }>(sql`SELECT id FROM async_jobs WHERE id IN (${sql.join([...planted, other].map((id) => sql`${id}`), sql`, `)})`);
      assert.deepEqual(left.map((r) => r.id), [other], "only the other queue's job is left");

      assert.deepEqual(await runMigration(), ["[0171] review_render_scenarios_prepare jobs deleted: none"], "a re-run is a no-op");
      const client2 = await pool.connect();
      try {
        assert.equal((await reviewRenderPrepareDropLosses(client2)).size, 0, "nothing left to count");
      } finally { client2.release(); }
    } finally {
      await db.execute(sql`DELETE FROM async_jobs WHERE payload->>'p' = ${P}`);
    }
  });
});
