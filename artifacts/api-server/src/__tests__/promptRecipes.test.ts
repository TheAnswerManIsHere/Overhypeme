// The prompt tuner, part 2: recipe versions and promotions against the test
// database (plan PLAN_PROMPT_TUNER.md, *Proposed Design* A and D, *Security*).
// Seeds one engine family under a `t-pr-` prefix.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import { factsTable, imagePromptAttemptsTable, promptRecipePromotionsTable, promptRecipeVersionsTable, usersTable } from "@workspace/db/schema";
import { defaultIdentityPolicyForRenderMode } from "@workspace/api-zod";
import { eq, inArray } from "drizzle-orm";

import adminPromptRecipesRouter from "../routes/adminPromptRecipes.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { ALL_ENGINES } from "../lib/engines/index.js";
import { liveRecipeVersionIdsForEngines, liveRecipeVersionIds } from "../lib/imagePrompt/recipeStore.js";
import { BASELINE_PIECES } from "../lib/imagePrompt/recipe.js";
import { computeScenarioInputHash } from "../lib/reviewRenderScenarios.js";
import { VALID_ENRICHMENT } from "./helpers/validEnrichment.js";
import { testEngineRow } from "./helpers/testEngines.js";
import { clearTestEngineDefinitions } from "../lib/engineInterpreter.js";
import { withCast } from "./helpers/gagCast.js";

const P = `t-pr-${randomUUID().slice(0, 6)}`;
const FAMILY = `${P}-gpt`;
const OTHER = `${P}-nb`;
const engineIds: string[] = [];
let adminId = "";

// One wrapper scopes the file-level hooks to this file: with test isolation off,
// a root-level before runs when the shard starts, and another file's cleanup of
// test engines then removed this file's before its tests ran.
describe("prompt recipes (file)", () => {
before(async () => {
  for (const [family, src] of [[FAMILY, "gpt-image-2-6"], [FAMILY, "gpt-image-2-6-edit"], [OTHER, "nano-banana-2-1"]] as const) {
    const def = ALL_ENGINES.find((e) => e.id === src)!;
    const id = `${family}-${def.imageMode}`;
    testEngineRow(def, id, family);
    engineIds.push(id);
  }
  adminId = `${P}-admin`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true });
});

after(async () => {
  await db.delete(promptRecipePromotionsTable).where(inArray(promptRecipePromotionsTable.engineFamily, [FAMILY, OTHER]));
  await db.delete(promptRecipeVersionsTable).where(inArray(promptRecipeVersionsTable.engineFamily, [FAMILY, OTHER]));
  clearTestEngineDefinitions();
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
    assert.ok(res.body.pieces.find((p: { key: string; policy: boolean }) => p.key === "text.overlay").policy);
    // The violence rule is no recipe piece: no version may reword or drop it (PLAN_GAG_DIRECT_RENDER.md, B).
    assert.equal(res.body.pieces.find((p: { key: string }) => p.key === "violence.allow"), undefined);
    const fam = res.body.families.find((f: { family: string }) => f.family === FAMILY);
    assert.equal(fam.liveVersionId, null);
    assert.equal(fam.engines.length, 2);
    // Each chosen engine family lists its own baseline (compiler review, Phase 1).
    const gpt = res.body.families.find((f: { family: string }) => f.family === "gpt-image-2-6");
    assert.equal(gpt.baselinePieces["shape.join"], "\n\n", "GPT Image 2.6: one section per paragraph");
    assert.equal(gpt.baselinePieces["shape.section"], "{label}: {body}");
    const nb21 = res.body.families.find((f: { family: string }) => f.family === "nano-banana-2-1");
    assert.equal(nb21.baselinePieces["shape.section"], "{body}", "Nano Banana 2.1: unlabeled paragraphs");
    const nb2 = res.body.families.find((f: { family: string }) => f.family === "nano-banana-2");
    assert.equal(nb2.baselinePieces["identity.person"], BASELINE_PIECES["identity.person"], "Nano Banana 2 keeps today's wording");
  });

  it("saves numbered versions, never editing one, and refuses malformed, over-budget or unchanged wording", async () => {
    const bad = await save({ "composition.captionSpace": "Leave room for the caption." });
    assert.equal(bad.status, 409);
    assert.ok(bad.body.problems.some((p: string) => /must contain \{side\}/.test(p)));

    const long = await save({ "identity.person": "x".repeat(1400), "style.photoreal": "x".repeat(1400), "text.incidental": "x".repeat(1400), "text.overlay": `${"x".repeat(1400)} {forbidden}` });
    assert.equal(long.status, 409, "a recipe that cannot leave room for every valid moderator scene is refused");
    assert.ok(long.body.problems.some((p: string) => /too long for the prompt/.test(p)), JSON.stringify(long.body));

    const balloons = await save({ "bubbles.speech": `${"y".repeat(1400)} {who} {text}` });
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
    const v = await save({ "identity.pet": "Keep the pet in the photo recognisable." }, "pet wording");
    const ok = await promote({ versionId: v.body.version.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await liveRecipeVersionIds([FAMILY, OTHER])).get(FAMILY), v.body.version.id);
    assert.equal((await liveRecipeVersionIds([FAMILY, OTHER])).get(OTHER), null, "another family is untouched");
    assert.equal((await liveRecipeVersionIdsForEngines([`${FAMILY}-i2i`])).get(`${FAMILY}-i2i`), v.body.version.id, "every engine of the family");

    const policy = await save({ "text.incidental": "Keep background text unreadable." }, "policy");
    const unconfirmed = await promote({ versionId: policy.body.version.id });
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.needsPolicyConfirmation, true);
    assert.deepEqual(unconfirmed.body.changedPolicy, ["text.incidental"]);
    assert.equal((await liveRecipeVersionIds([FAMILY])).get(FAMILY), v.body.version.id, "a refused promotion writes nothing");
    const confirmed = await promote({ versionId: policy.body.version.id, confirmPolicy: true });
    assert.equal(confirmed.status, 200);

    const foreign = await save({ "identity.pet": "Other family." }, "x", OTHER);
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

describe("an attempt records the wording its caller froze (Codex, PR #926 round 2)", () => {
  it("a caller's version wins over a promotion that landed since, null being the frozen baseline; omitted reads the live one", async () => {
    const { buildAndEnqueueImagePromptAttempt } = await import("../lib/imagePromptAttempts.js");
    const { syntheticAnalysisForReference, defaultScenarioRenderControls } = await import("../lib/reviewRenderScenarios.js");
    const { defaultIdentityPolicyForRenderMode } = await import("@workspace/api-zod");
    const { asyncJobsTable } = await import("@workspace/db/schema");
    const [fact] = await db.insert(factsTable).values({ text: `${P} {NAME} lifts a car`, isActive: false, enrichment: VALID_ENRICHMENT as never }).returning({ id: factsTable.id });
    const v = await save({ "identity.person": "Wording B for the person photo." }, "B");
    await promote({ versionId: v.body.version.id });
    const enqueue = (extra: Record<string, unknown>) => buildAndEnqueueImagePromptAttempt({
      factId: fact!.id, userId: null, enrichment: VALID_ENRICHMENT as never, renderedFactText: "Alex lifts a car",
      analysis: syntheticAnalysisForReference("male"), subjectRenderMode: "human_identity_i2i",
      identityPolicy: defaultIdentityPolicyForRenderMode("human_identity_i2i"), renderControls: defaultScenarioRenderControls() as never,
      imageEngineId: `${FAMILY}-i2i`, ...extra,
    });
    const ids: number[] = [];
    try {
      const frozen = await enqueue({ recipeVersionId: null });
      const live = await enqueue({});
      ids.push(frozen.attemptId, live.attemptId);
      const rows = await db.select({ id: imagePromptAttemptsTable.id, v: imagePromptAttemptsTable.recipeVersionId }).from(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.id, ids));
      assert.equal(rows.find((r) => r.id === frozen.attemptId)!.v, null, "the baseline its caller hashed, not the version promoted since");
      assert.equal(rows.find((r) => r.id === live.attemptId)!.v, v.body.version.id, "no version given: the live one");
    } finally {
      await promote({ versionId: null, confirmPolicy: true });
      for (const id of ids) await db.delete(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `image_prompt_generation:attempt:${id}`));
      await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.id, ids.length ? ids : [0]));
      await db.delete(factsTable).where(eq(factsTable.id, fact!.id));
    }
  });
});

// The wording preview compiles the gag frozen on the fact's newest compiled
// attempt (PLAN_GAG_DIRECT_RENDER.md, D: "the prompt-wording preview handles
// both kinds"). A direct attempt stores only its compiled prompt; a planned
// one before the switch stored a plan too; one frozen before casts were read
// cannot be compiled directly and is passed over, never drawn with another gag.
describe("prompt recipe preview — which stored picture it compiles", () => {
  const previewFactIds: number[] = [];
  after(async () => {
    if (previewFactIds.length === 0) return;
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, previewFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, previewFactIds));
  });

  async function seedFact(): Promise<number> {
    const [fact] = await db.insert(factsTable)
      .values({ text: "{NAME} doesn't read books.", submittedById: adminId, isActive: false, enrichment: VALID_ENRICHMENT })
      .returning({ id: factsTable.id });
    previewFactIds.push(fact!.id);
    return fact!.id;
  }

  async function seedAttempt(factId: number, opts: { scene: string; castCurrent: boolean; compiled: boolean; planned?: boolean }): Promise<number> {
    const gag = withCast({ version: 1, coreSceneOverride: opts.scene, bubbles: [] } as never) as Record<string, unknown>;
    if (!opts.castCurrent) { delete gag["cast"]; delete gag["castExtraction"]; }
    const [row] = await db.insert(imagePromptAttemptsTable).values({
      factId,
      userId: adminId,
      renderJobId: randomUUID(),
      generationMode: "i2i",
      subjectRenderMode: "human_identity_i2i",
      targetEngine: "nano_banana_2",
      sourceImageAnalysis: {
        subjectKind: "human_face", confidence: "high", hasUsableHumanFace: true, hasUsableSubject: true,
        subjectCount: 1, warnings: [], suggestedRenderMode: "human_identity_i2i",
        classificationMethod: "fal_detector", analyzerVersion: "v1",
      } as never,
      identityPolicy: defaultIdentityPolicyForRenderMode("human_identity_i2i") as never,
      renderControls: { aspectRatio: "portrait", contentMode: "sfw", promptIdentity: { version: 1, name: "David", pronouns: "he/him", source: "review_sample" } } as never,
      factEnrichmentSnapshot: { ...VALID_ENRICHMENT, visualPromptStrategyOverride: gag } as never,
      renderedFactText: "David doesn't read books.",
      archetypeStrategyVersion: "v2",
      visualPlan: opts.planned ? ({ planned: true } as never) : null,
      compiledPrompt: opts.compiled ? ({ imagePrompt: "stored" } as never) : null,
    }).returning({ id: imagePromptAttemptsTable.id });
    return row!.id;
  }

  const preview = (factId: number) => request(app()).post(`/api/admin/prompt-recipes/${FAMILY}/preview`)
    .send({ pieces: {}, factId, subjectRenderMode: "human_identity_i2i" });

  it("compiles an attempt drawn the direct way, which stores no plan", async () => {
    const factId = await seedFact();
    const id = await seedAttempt(factId, { scene: "{NAME} lifts a city bus.", castCurrent: true, compiled: true });
    const res = await preview(factId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attemptId, id);
    assert.match(res.body.prompt, /lifts a city bus/);
  });

  it("passes over a newer attempt that never compiled, and one frozen before casts were read, for the newest that compiles", async () => {
    const factId = await seedFact();
    const usable = await seedAttempt(factId, { scene: "{NAME} juggles three anvils.", castCurrent: true, compiled: true, planned: true });
    await seedAttempt(factId, { scene: "{NAME} outruns a cheetah.", castCurrent: false, compiled: true, planned: true });
    await seedAttempt(factId, { scene: "{NAME} wrestles a bear.", castCurrent: true, compiled: false });
    const res = await preview(factId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attemptId, usable, "the planned attempt whose own frozen gag still compiles");
    assert.match(res.body.prompt, /juggles three anvils/);
    assert.doesNotMatch(res.body.prompt, /cheetah|bear/, "no other attempt's gag, and no gag substituted");
  });

  it("refuses, saying how to make one, when every compiled attempt predates casts", async () => {
    const factId = await seedFact();
    await seedAttempt(factId, { scene: "{NAME} outruns a cheetah.", castCurrent: false, compiled: true, planned: true });
    const res = await preview(factId);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "render_unusable");
    assert.match(res.body.refusal, /moderation render/);
  });

  it("refuses with 404 when the fact has no compiled attempt for that photo type", async () => {
    const factId = await seedFact();
    await seedAttempt(factId, { scene: "{NAME} wrestles a bear.", castCurrent: true, compiled: false });
    const res = await preview(factId);
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error, "no_stored_render");
  });
});
});
