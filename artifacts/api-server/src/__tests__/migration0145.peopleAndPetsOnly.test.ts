/**
 * Migration 0145 (plan docs/plans/PLAN_GAG_EXAMPLES.md, increment 2; Issue
 * #964): a picture's subject is a person or a pet, and under "Deprecated means
 * removed" (decisions.md, 2026-11-17) the records only the vehicle, object and
 * mascot subject kinds produced are deleted or converted.
 *
 *   - the row-state matrix: a render from the object/vehicle reference, one
 *     whose photo analysis or visual plan names an object, vehicle or mascot
 *     subject, and a comparison panel of that scenario are deleted; a male, a
 *     pet and an unrelated render are kept; a comparison set loses only the
 *     scenario key; a gag's legacy pick snapshot on a deleted render is
 *     cleared; a stored recipe loses only "identity.object";
 *   - a second run changes nothing;
 *   - a render that is a gag's example is never deleted: the migration refuses.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_SQL = readFileSync(path.join(ROOT, "lib/db/migrations/0145_people_and_pets_only.sql"), "utf8");
const P = "t_0144_";
const RUN = randomUUID().slice(0, 8);
const OV = "i2i_nonhuman_object_vehicle";

async function one<T>(q: ReturnType<typeof sql>): Promise<T> {
  return (await db.execute(q)).rows[0] as T;
}
async function exists(table: string, id: number): Promise<boolean> {
  return (await db.execute(sql`SELECT 1 FROM ${sql.raw(table)} WHERE id = ${id}`)).rows.length > 0;
}

/** A deactivated fact once approved for production: its gags may hold published content (0157). */
async function fact(name: string): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO facts (text, is_active, enrichment, approved_at, approval_source) VALUES (${`${P}${RUN} ${name}`}, false, '{}'::jsonb, now(), 'legacy') RETURNING id`)).id;
}

interface AttemptOpts { scenarioKey?: string | null; evalScenarioKey?: string | null; identityType?: string | null; subjectKind?: string; planKind?: string }
async function attempt(factId: number, o: AttemptOpts = {}): Promise<number> {
  const analysis = o.subjectKind ? { subjectKind: o.subjectKind } : {};
  const plan = o.planKind ? { subjectTreatment: { nonhumanSubjectTreatment: { subjectKind: o.planKind } } } : null;
  return (await one<{ id: number }>(sql`
    INSERT INTO image_prompt_attempts (fact_id, review_render_scenario_key, eval_scenario_key, review_reference_identity_type, render_job_id,
      generation_mode, subject_render_mode, target_engine, source_image_analysis, identity_policy, render_controls,
      fact_enrichment_snapshot, archetype_strategy_version, visual_plan)
    VALUES (${factId}, ${o.scenarioKey ?? null}, ${o.evalScenarioKey ?? null}, ${o.identityType ?? null}, ${randomUUID()},
      'i2i', 'nonhuman_subject_i2i', 'nano_banana_2', ${JSON.stringify(analysis)}::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, 'v2', ${plan == null ? null : JSON.stringify(plan)}::jsonb)
    RETURNING id::integer AS id`)).id;
}

async function comparisonSet(scenarioKeys: string[]): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO comparison_sets (label, round, fact_ids, scenario_keys, look_style_ids, engine_families)
    VALUES (${`${P}${RUN}`}, 1, '[]'::jsonb, ${JSON.stringify(scenarioKeys)}::jsonb, '[]'::jsonb, '[]'::jsonb)
    RETURNING id::integer AS id`)).id;
}
async function panel(setId: number, factId: number, scenarioKey: string, identityType: string | null): Promise<number> {
  return (await one<{ id: number }>(sql`
    INSERT INTO comparison_panels (set_id, fact_id, scenario_key, look_style_id, image_mode, reference_identity_type, shuffle_seed)
    VALUES (${setId}, ${factId}, ${scenarioKey}, ${"none-" + randomUUID().slice(0, 6)}, 'i2i', ${identityType}, 1)
    RETURNING id::integer AS id`)).id;
}
async function recipe(pieces: Record<string, string>): Promise<number> {
  const n = (await one<{ n: number }>(sql`SELECT coalesce(max(number), 0)::integer + 1 AS n FROM prompt_recipe_versions WHERE engine_family = ${P + RUN}`)).n;
  return (await one<{ id: number }>(sql`
    INSERT INTO prompt_recipe_versions (engine_family, number, pieces, note)
    VALUES (${P + RUN}, ${n}, ${JSON.stringify(pieces)}::jsonb, 'test') RETURNING id::integer AS id`)).id;
}

describe("migration 0145: people and pets only", () => {
  const ids: Record<string, number> = {};

  before(async () => {
    const f = await fact("matrix");
    ids.f = f;
    ids.ovScenario = await attempt(f, { scenarioKey: OV, identityType: "nonhuman_object_vehicle" });
    ids.ovEval = await attempt(f, { evalScenarioKey: OV });
    ids.vehicleAnalysis = await attempt(f, { subjectKind: "vehicle_subject" });
    ids.mascotPlan = await attempt(f, { planKind: "mascot_or_character_subject" });
    ids.objectAnalysis = await attempt(f, { subjectKind: "object_subject" });
    ids.male = await attempt(f, { scenarioKey: "i2i_male_default", identityType: "male", subjectKind: "human_face" });
    ids.pet = await attempt(f, { scenarioKey: "i2i_nonhuman_animal", identityType: "nonhuman_animal", subjectKind: "animal_subject", planKind: "animal_subject" });
    ids.plain = await attempt(f);

    // A carried-over gag whose legacy pick snapshot points at a vehicle render.
    ids.gag = (await one<{ id: number }>(sql`
      INSERT INTO fact_gags (fact_id, slot, approved_content, approved_carried_over, approved_example_attempt_id)
      VALUES (${f}, 1, ${JSON.stringify({ version: 1, coreSceneOverride: "{NAME} lifts a car." })}::jsonb, true, ${ids.ovScenario})
      RETURNING id::integer AS id`)).id;

    ids.set = await comparisonSet(["i2i_male_default", OV, "i2i_nonhuman_animal"]);
    ids.ovPanel = await panel(ids.set, f, OV, "nonhuman_object_vehicle");
    ids.malePanel = await panel(ids.set, f, "i2i_male_default", "male");

    ids.recipe = await recipe({ "identity.object": "A pet or an object.", "identity.person": "Keep the person." });

    await db.execute(sql.raw(MIGRATION_SQL));
  });

  it("deletes every render only a vehicle, object or mascot subject produced", async () => {
    for (const k of ["ovScenario", "ovEval", "vehicleAnalysis", "mascotPlan", "objectAnalysis"]) {
      assert.equal(await exists("image_prompt_attempts", ids[k]!), false, `${k} is deleted`);
    }
  });

  it("keeps male, pet and unrelated renders", async () => {
    for (const k of ["male", "pet", "plain"]) {
      assert.equal(await exists("image_prompt_attempts", ids[k]!), true, `${k} is kept`);
    }
  });

  it("clears a gag's legacy pick snapshot on a deleted render and keeps the gag", async () => {
    const g = await one<{ approved_example_attempt_id: number | null; approved_content: unknown }>(sql`
      SELECT approved_example_attempt_id, approved_content FROM fact_gags WHERE id = ${ids.gag}`);
    assert.equal(g.approved_example_attempt_id, null);
    assert.ok(g.approved_content, "the gag itself is untouched");
  });

  it("deletes the object/vehicle comparison panel and takes the key out of the set", async () => {
    assert.equal(await exists("comparison_panels", ids.ovPanel!), false);
    assert.equal(await exists("comparison_panels", ids.malePanel!), true);
    const s = await one<{ scenario_keys: string[] }>(sql`SELECT scenario_keys FROM comparison_sets WHERE id = ${ids.set}`);
    assert.deepEqual(s.scenario_keys, ["i2i_male_default", "i2i_nonhuman_animal"]);
  });

  it("removes only the identity.object piece from a stored recipe", async () => {
    const r = await one<{ pieces: Record<string, string> }>(sql`SELECT pieces FROM prompt_recipe_versions WHERE id = ${ids.recipe}`);
    assert.deepEqual(r.pieces, { "identity.person": "Keep the person." });
  });

  it("changes nothing on a second run", async () => {
    const before = await one<{ a: number; p: number }>(sql`
      SELECT (SELECT count(*) FROM image_prompt_attempts)::integer AS a, (SELECT count(*) FROM comparison_panels)::integer AS p`);
    await db.execute(sql.raw(MIGRATION_SQL));
    const after = await one<{ a: number; p: number }>(sql`
      SELECT (SELECT count(*) FROM image_prompt_attempts)::integer AS a, (SELECT count(*) FROM comparison_panels)::integer AS p`);
    assert.deepEqual(after, before);
  });

  it("refuses rather than delete a render that is a gag's example", async () => {
    const f = await fact("example");
    const a = await attempt(f, { scenarioKey: "i2i_nonhuman_animal", identityType: "nonhuman_animal", planKind: "object_subject" });
    const client = await (await import("@workspace/db")).pool.connect();
    try {
      await client.query("BEGIN");
      const g = await client.query(
        `INSERT INTO fact_gags (fact_id, slot, approved_content, approved_carried_over) VALUES ($1, 1, '{"version":1,"coreSceneOverride":"x"}'::jsonb, true) RETURNING id`, [f]);
      await client.query(`INSERT INTO fact_gag_examples (gag_id, subject_kind, stage, attempt_id) VALUES ($1, 'pet', 'pending', $2)`, [g.rows[0].id, a]);
      await assert.rejects(client.query(MIGRATION_SQL), /refusing to break an example set/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
