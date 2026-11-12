// The prompt tuner, part 2: recipe versions and promotions against the test
// database (plan PLAN_PROMPT_TUNER.md, *Proposed Design* A and D, *Security*).
// Seeds one engine family under a `t-pr-` prefix.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { enginesTable, promptRecipePromotionsTable, promptRecipeVersionsTable, usersTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

import adminPromptRecipesRouter from "../routes/adminPromptRecipes.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { codeDefinitionToRow } from "../lib/engines/reconcile.js";
import { liveRecipeVersionIdsForEngines, liveRecipeVersionIds } from "../lib/imagePrompt/recipeStore.js";
import { BASELINE_PIECES } from "../lib/imagePrompt/recipe.js";
import { computeScenarioInputHash } from "../lib/reviewRenderScenarios.js";
import { VALID_ENRICHMENT } from "./helpers/stubPlanner.js";

const P = `t-pr-${randomUUID().slice(0, 6)}`;
const FAMILY = `${P}-gpt`;
const OTHER = `${P}-nb`;
const engineIds: string[] = [];
let adminId = "";

before(async () => {
  for (const [family, src] of [[FAMILY, "gpt-image-2-6"], [FAMILY, "gpt-image-2-6-edit"], [OTHER, "nano-banana-2-1"]] as const) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${family}-${def.imageMode}`;
    await db.insert(enginesTable).values({ ...codeDefinitionToRow(def), id, family, isDefault: false });
    engineIds.push(id);
  }
  adminId = `${P}-admin`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
});

after(async () => {
  await db.delete(promptRecipePromotionsTable).where(inArray(promptRecipePromotionsTable.engineFamily, [FAMILY, OTHER]));
  await db.delete(promptRecipeVersionsTable).where(inArray(promptRecipeVersionsTable.engineFamily, [FAMILY, OTHER]));
  await db.delete(enginesTable).where(inArray(enginesTable.id, engineIds));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

const app = () => buildTestApp({ kind: "authenticated", userId: adminId }, adminPromptRecipesRouter);
const save = (pieces: Record<string, string>, note = "test", family = FAMILY) => request(app()).post(`/api/admin/prompt-recipes/${family}/versions`).send({ pieces, note });
const promote = (body: Record<string, unknown>, family = FAMILY) => request(app()).post(`/api/admin/prompt-recipes/${family}/promote`).send(body);

describe("prompt recipe versions", () => {
  it("lists every piece with its baseline, and each family with no version as the baseline", async () => {
    const res = await request(app()).get("/api/admin/prompt-recipes");
    assert.equal(res.status, 200);
    const identity = res.body.pieces.find((p: { key: string }) => p.key === "identity.person");
    assert.equal(identity.baseline, BASELINE_PIECES["identity.person"]);
    assert.ok(res.body.pieces.find((p: { key: string; policy: boolean }) => p.key === "violence.allow").policy);
    const fam = res.body.families.find((f: { family: string }) => f.family === FAMILY);
    assert.equal(fam.liveVersionId, null);
    assert.equal(fam.engines.length, 2);
  });

  it("saves numbered versions, never editing one, and refuses malformed, over-budget or unchanged wording", async () => {
    const bad = await save({ "constraints.duplicate": "Never clone them." });
    assert.equal(bad.status, 409);
    assert.ok(bad.body.problems.some((p: string) => /must contain \{subject\}/.test(p)));

    const long = await save({ "identity.person": "x".repeat(1400) });
    assert.equal(long.status, 409, "a recipe that cannot leave room for every valid moderator scene is refused");
    assert.ok(long.body.problems.some((p: string) => /too long for the prompt/.test(p)), JSON.stringify(long.body));

    const balloons = await save({ "bubbles.speech": `${"y".repeat(330)} {who} {text}` });
    assert.equal(balloons.status, 409, "balloon wording is counted once per balloon, at the most balloons a fact may have");

    const v1 = await save({ "identity.person": "Use the photo as the person's face." }, "shorter identity");
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    assert.equal(v1.body.version.number, 1);
    const same = await save({ "identity.person": BASELINE_PIECES["identity.person"] });
    assert.equal(same.status, 409, "nothing changed from the live (baseline) wording");
    const v2 = await save({ "label.coreScene": "THE SCENE" }, "label");
    assert.equal(v2.body.version.number, 2);
    const [row] = await db.select().from(promptRecipeVersionsTable).where(eq(promptRecipeVersionsTable.id, v2.body.version.id));
    assert.equal((row!.pieces as Record<string, string>)["identity.person"], BASELINE_PIECES["identity.person"], "a version saved over the baseline holds every piece");

    const unknownFamily = await save({ "identity.person": "x" }, "n", "no-such-family");
    assert.equal(unknownFamily.status, 409);
  });
});

describe("promotion", () => {
  it("makes a version live for its family only, needs a second confirmation for a policy change, and promoting null restores the baseline", async () => {
    const v = await save({ "identity.none": "Draw an original protagonist." }, "t2i wording");
    const ok = await promote({ versionId: v.body.version.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await liveRecipeVersionIds([FAMILY, OTHER])).get(FAMILY), v.body.version.id);
    assert.equal((await liveRecipeVersionIds([FAMILY, OTHER])).get(OTHER), null, "another family is untouched");
    assert.equal((await liveRecipeVersionIdsForEngines([`${FAMILY}-i2i`])).get(`${FAMILY}-i2i`), v.body.version.id, "every engine of the family");

    const policy = await save({ "violence.allow": "Show the action, no gore." }, "policy");
    const unconfirmed = await promote({ versionId: policy.body.version.id });
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.needsPolicyConfirmation, true);
    assert.deepEqual(unconfirmed.body.changedPolicy, ["violence.allow"]);
    assert.equal((await liveRecipeVersionIds([FAMILY])).get(FAMILY), v.body.version.id, "a refused promotion writes nothing");
    const confirmed = await promote({ versionId: policy.body.version.id, confirmPolicy: true });
    assert.equal(confirmed.status, 200);

    const foreign = await save({ "identity.none": "Other family." }, "x", OTHER);
    assert.equal((await promote({ versionId: foreign.body.version.id })).status, 409, "a version of another family is refused");

    const restore = await promote({ versionId: null, confirmPolicy: true });
    assert.equal(restore.status, 200);
    assert.equal((await liveRecipeVersionIds([FAMILY])).get(FAMILY), null);
    const listed = await request(app()).get("/api/admin/prompt-recipes");
    const fam = listed.body.families.find((f: { family: string }) => f.family === FAMILY);
    assert.ok(fam.promotions.length >= 3, "the history is kept");
  });
});

describe("the moderation freshness hash", () => {
  it("is unchanged by recipe support until a version is live for the routed engine", () => {
    const base = { t2i: "e-t2i", i2i: "e-i2i" };
    const plain = computeScenarioInputHash("i2i_male_default", 1, "x", VALID_ENRICHMENT as never, base);
    const nullRecipes = computeScenarioInputHash("i2i_male_default", 1, "x", VALID_ENRICHMENT as never, { ...base, recipeVersions: { t2i: null, i2i: null } });
    const promoted = computeScenarioInputHash("i2i_male_default", 1, "x", VALID_ENRICHMENT as never, { ...base, recipeVersions: { t2i: null, i2i: 5 } });
    const otherMode = computeScenarioInputHash("i2i_male_default", 1, "x", VALID_ENRICHMENT as never, { ...base, recipeVersions: { t2i: 5, i2i: null } });
    assert.equal(nullRecipes, plain, "no promotion: every existing render stays current");
    assert.notEqual(promoted, plain, "a promotion for the engine it renders with makes it out of date");
    assert.equal(otherMode, plain, "a promotion for another mode's engine does not");
  });
});
