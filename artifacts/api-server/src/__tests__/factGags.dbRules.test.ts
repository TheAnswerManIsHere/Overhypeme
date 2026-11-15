/**
 * The database rules for gags (migration 0139; plan
 * docs/plans/PLAN_THREE_GAGS.md, Testing Plan item 4), by raw SQL so nothing
 * in the application stands between the statement and the rule:
 *   - a fourth gag, a duplicate live slot, an approved version with no example set
 *     outside the migration's carried-over marker, an empty scene, and a
 *     refresh-only operation with no owning review are refused;
 *   - a fact cannot be activated without an approved gag, and the last
 *     approved gag of a live fact cannot be removed or emptied;
 *   - with two connections, two concurrent removals of a live fact's two
 *     approved gags, and an activation racing a removal, leave the rule intact:
 *     validation sees the preceding committed change.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { buildPlaceholderGag } from "@workspace/api-zod";

const P = "t_gag_rules_";
const GAG = JSON.stringify(buildPlaceholderGag("{NAME} holds the line."));

async function cleanup() {
  await db.execute(sql`DELETE FROM facts WHERE text LIKE ${P + "%"}`);
}

/** An inactive fact, then its gags, then (optionally) activate it: one transaction. */
async function makeFact(name: string, opts: { gags: number; active: boolean }): Promise<{ factId: number; gagIds: number[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const f = await client.query("INSERT INTO facts (text, is_active) VALUES ($1, false) RETURNING id", [P + name]);
    const factId = f.rows[0].id as number;
    const gagIds: number[] = [];
    for (let slot = 1; slot <= opts.gags; slot++) {
      const g = await client.query(
        "INSERT INTO fact_gags (fact_id, slot, approved_content, approved_carried_over) VALUES ($1, $2, $3::jsonb, true) RETURNING id::integer AS id",
        [factId, slot, GAG],
      );
      gagIds.push(g.rows[0].id);
    }
    if (opts.active) await client.query("UPDATE facts SET is_active = true WHERE id = $1", [factId]);
    await client.query("COMMIT");
    return { factId, gagIds };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const exec = (q: string, params: unknown[] = []) => pool.query(q, params);

describe("fact_gags: rules the database enforces", () => {
  before(cleanup);
  after(cleanup);

  it("refuses a fourth gag and a second live gag in one slot", async () => {
    const { factId } = await makeFact("fourth", { gags: 3, active: false });
    await assert.rejects(exec("INSERT INTO fact_gags (fact_id, slot, pending_content) VALUES ($1, 4, $2::jsonb)", [factId, GAG]), /fact_gags_slot_range/);
    await assert.rejects(exec("INSERT INTO fact_gags (fact_id, slot, pending_content) VALUES ($1, 2, $2::jsonb)", [factId, GAG]), /UQ_fact_gags_fact_slot_live/);
  });

  it("allows a new gag in a slot once the old one there is removed", async () => {
    const { factId, gagIds } = await makeFact("reuse-slot", { gags: 2, active: false });
    await exec("UPDATE fact_gags SET removed_at = now() WHERE id = $1", [gagIds[1]]);
    await exec("INSERT INTO fact_gags (fact_id, slot, pending_content) VALUES ($1, 2, $2::jsonb)", [factId, GAG]);
  });

  it("refuses an approved version without its male, female and pet examples unless grandfathered, an empty scene, and a gag with no version", async () => {
    const { factId } = await makeFact("shape", { gags: 0, active: false });
    await assert.rejects(exec("INSERT INTO fact_gags (fact_id, slot, approved_content) VALUES ($1, 1, $2::jsonb)", [factId, GAG]), /without its male, female and pet examples/);
    await assert.rejects(exec(`INSERT INTO fact_gags (fact_id, slot, pending_content) VALUES ($1, 1, '{"coreSceneOverride":"  "}'::jsonb)`, [factId]), /fact_gags_pending_scene_nonempty/);
    await assert.rejects(exec(`INSERT INTO fact_gags (fact_id, slot, pending_content) VALUES ($1, 1, '{"coreSceneOverride":42}'::jsonb)`, [factId]), /fact_gags_pending_scene_nonempty/);
    await assert.rejects(exec("INSERT INTO fact_gags (fact_id, slot) VALUES ($1, 1)", [factId]), /fact_gags_has_a_version/);
  });

  it("refuses a pending removal or example pick that no refresh review owns", async () => {
    const { gagIds } = await makeFact("owned", { gags: 1, active: false });
    await assert.rejects(exec("UPDATE fact_gags SET pending_remove = true WHERE id = $1", [gagIds[0]]), /fact_gags_pending_ops_owned/);
  });

  it("refuses activating a fact with no approved gag, including one with only a pending gag", async () => {
    const { factId } = await makeFact("no-gag", { gags: 0, active: false });
    await assert.rejects(exec("UPDATE facts SET is_active = true WHERE id = $1", [factId]), /no approved gag/);
    await exec("INSERT INTO fact_gags (fact_id, slot, pending_content) VALUES ($1, 1, $2::jsonb)", [factId, GAG]);
    await assert.rejects(exec("UPDATE facts SET is_active = true WHERE id = $1", [factId]), /no approved gag/);
    await assert.rejects(exec("INSERT INTO facts (text, is_active) VALUES ($1, true)", [P + "born-live"]), /no approved gag/);
  });

  it("refuses removing, emptying or deleting the last approved gag of a live fact, and allows it with another left", async () => {
    const one = await makeFact("last", { gags: 1, active: true });
    await assert.rejects(exec("UPDATE fact_gags SET removed_at = now() WHERE id = $1", [one.gagIds[0]]), /no approved gag/);
    await assert.rejects(exec("UPDATE fact_gags SET approved_content = NULL, pending_content = $2::jsonb WHERE id = $1", [one.gagIds[0], GAG]), /no approved gag/);
    await assert.rejects(exec("DELETE FROM fact_gags WHERE id = $1", [one.gagIds[0]]), /no approved gag/);
    const two = await makeFact("not-last", { gags: 2, active: true });
    await exec("UPDATE fact_gags SET removed_at = now() WHERE id = $1", [two.gagIds[0]]);
  });

  it("deleting a live fact takes its gags with it", async () => {
    const { factId } = await makeFact("delete", { gags: 2, active: true });
    await exec("DELETE FROM facts WHERE id = $1", [factId]);
    const r = await exec("SELECT count(*)::int AS n FROM fact_gags WHERE fact_id = $1", [factId]);
    assert.equal(r.rows[0].n, 0);
  });

  it("two connections removing a live fact's two approved gags: the second is refused", async () => {
    const { factId, gagIds } = await makeFact("race-remove", { gags: 2, active: true });
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query("UPDATE fact_gags SET removed_at = now() WHERE id = $1", [gagIds[0]]);
      await b.query("UPDATE fact_gags SET removed_at = now() WHERE id = $1", [gagIds[1]]);
      await a.query("COMMIT");
      await assert.rejects(b.query("COMMIT"), /no approved gag/);
    } finally {
      await a.query("ROLLBACK").catch(() => {});
      await b.query("ROLLBACK").catch(() => {});
      a.release();
      b.release();
    }
    const r = await exec("SELECT count(*)::int AS n FROM fact_gags WHERE fact_id = $1 AND removed_at IS NULL", [factId]);
    assert.equal(r.rows[0].n, 1, "one approved gag remains");
  });

  it("an activation racing the removal of the only approved gag: one of them is refused", async () => {
    const { factId, gagIds } = await makeFact("race-activate", { gags: 1, active: false });
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query("UPDATE facts SET is_active = true WHERE id = $1", [factId]);
      await b.query("UPDATE fact_gags SET removed_at = now() WHERE id = $1", [gagIds[0]]);
      const bCommit = b.query("COMMIT").then(() => "ok", (e: Error) => e.message);
      const aCommit = a.query("COMMIT").then(() => "ok", (e: Error) => e.message);
      const results = await Promise.all([aCommit, bCommit]);
      assert.equal(results.filter((r) => r === "ok").length, 1, `exactly one commits: ${JSON.stringify(results)}`);
    } finally {
      a.release();
      b.release();
    }
    const r = await exec(`
      SELECT f.is_active,
             EXISTS (SELECT 1 FROM fact_gags g WHERE g.fact_id = f.id AND g.removed_at IS NULL AND g.approved_content IS NOT NULL) AS has_gag
        FROM facts f WHERE f.id = $1`, [factId]);
    assert.ok(!r.rows[0].is_active || r.rows[0].has_gag, "never live without an approved gag");
  });
});
