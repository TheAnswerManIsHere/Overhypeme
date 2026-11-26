/**
 * A gag's male, female and pet examples (plan docs/plans/PLAN_GAG_EXAMPLES.md,
 * Testing Plan items 2, 3, 5, 7a and 7b; the per-kind refusals of item 1 and
 * the refresh picks of item 4 are in routes.gags.test.ts, the gate of item 6
 * in routes.reviews.test.ts, the migration of item 7 in
 * migration0143.gagExampleSets.test.ts):
 *
 *   - a pick is a draft pick and never publishes: two concurrent picks of
 *     one kind leave one pick, and what users are offered does not change
 *     (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1F);
 *   - a grandfathered gag stays offered while its draft gains examples, and
 *     stops being grandfathered when that draft is published;
 *   - renders are counted per action: one male render per content, reused for
 *     the same content (A, then B, then back to A draws nothing new), one for
 *     two overlapping requests, a new one on an explicit redraw; "render female
 *     and pet" draws only what is missing; a failed render shows and redraws;
 *   - the database refuses, at commit, an approved set made incomplete or a
 *     grandfathered marker cleared early, and accepts a set replaced whole in
 *     one transaction.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { asyncJobsTable, imagePromptAttemptsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  buildPlaceholderFactEnrichment,
  GAG_EXAMPLE_KINDS,
  SCENARIO_FOR_KIND,
  type GagExampleKind,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

import gagsRouter from "../routes/gags.js";
import { __setReferenceFalUploadForTest } from "../lib/defaultReferenceResolver.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { availableGags } from "../lib/gags/resolver.js";
import { buildGagWorkingCards, drawGagKinds } from "../lib/reviewRenderScenarios.js";
import { pendingReviewsTable } from "@workspace/db/schema";
import { withCast } from "./helpers/gagCast.js";
import { approveGagRender, saveGagContent } from "../lib/gags/gagStore.js";
import { publishDraft } from "../lib/gags/publish.js";
import { describeDraftChanges } from "./helpers/gagExampleSets.js";

const RUN = randomUUID().slice(0, 8);
const START = new Date();
const scene = (text: string): VisualPromptStrategyOverride => withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const A = scene("{NAME} lifts the moon (approved).");

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

async function liveFact(): Promise<{ factId: number; gagId: number }> {
  const f = await insertLiveFact({ text: `{NAME} example sets ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, A);
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id };
}

/** A finished (or failed) render of `content` for one kind. */
async function render(factId: number, gagId: number, content: VisualPromptStrategyOverride, kind: GagExampleKind, opts: { failed?: boolean } = {}): Promise<number> {
  const [row] = await db.insert(imagePromptAttemptsTable).values({
    factId,
    gagId,
    reviewRenderScenarioKey: SCENARIO_FOR_KIND[kind],
    renderJobId: randomUUID(),
    generationMode: "t2i",
    subjectRenderMode: "t2i_fallback",
    targetEngine: "nano_banana_2",
    sourceImageAnalysis: {} as never,
    identityPolicy: {} as never,
    renderControls: {} as never,
    factEnrichmentSnapshot: { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: content } as never,
    archetypeStrategyVersion: "v2",
    generatedImageObjectPath: opts.failed ? null : `/objects/ai-bg-v2/${factId}/${randomUUID()}.png`,
    error: opts.failed ? "vendor failed" : null,
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

const url = (factId: number, rest = "") => `/api/admin/facts/${factId}/gags${rest}`;
// A live fact's gags are worked on through the store (the routes refuse a
// write with no review between phases; the fact sheet brings them back).
const live = () => ({ adminId, reviewId: null });
const approve = (factId: number, gagId: number, attemptId: number) => approveGagRender(factId, gagId, attemptId, live());
const save = (factId: number, gagId: number, content: VisualPromptStrategyOverride) => saveGagContent(factId, gagId, content, live());
const gagRow = async (gagId: number) => (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
const examples = async (gagId: number, stage: "approved" | "pending") =>
  db.select().from(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, stage)));
const attemptsOf = async (gagId: number) =>
  db.select({ id: imagePromptAttemptsTable.id, key: imagePromptAttemptsTable.reviewRenderScenarioKey })
    .from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.gagId, gagId));
const drawn = (r: Awaited<ReturnType<typeof drawGagKinds>>) => {
  assert.ok(!("error" in r), JSON.stringify(r));
  return r.enqueued;
};

// One wrapper scopes the hooks to this file: with test isolation off, root-level
// hooks run for the whole shard, so another file's cleanup could clear this
// file's fal stub before its tests ran.
describe("a gag's example sets", () => {
before(async () => {
  adminId = `t-gagex-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, gagsRouter);
  // No vendor call: the i2i reference upload is stubbed, as the render tests do.
  __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
});

after(async () => {
  __setReferenceFalUploadForTest(null);
  if (factIds.length) {
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START));
});

describe("a pick is a draft pick", () => {
  it("two concurrent picks of one kind leave one pick, and never change what users are offered", async () => {
    const { factId, gagId } = await liveFact();
    const change = scene("{NAME} lifts the sun (concurrent).");
    await save(factId, gagId, change);
    for (const kind of ["male", "female"] as const) await approve(factId, gagId, await render(factId, gagId, change, kind));

    const [p1, p2] = await Promise.all([render(factId, gagId, change, "pet"), render(factId, gagId, change, "pet")]);
    await Promise.all([approve(factId, gagId, p1), approve(factId, gagId, p2)]);

    const row = await gagRow(gagId);
    assert.deepEqual(row.approvedContent, A, "the published version is untouched");
    assert.deepEqual(row.pendingContent, change, "the change waits in the draft");
    const pending = await examples(gagId, "pending");
    assert.deepEqual(pending.map((e) => e.subjectKind).sort(), ["female", "male", "pet"], "one draft pick per kind");
    assert.equal((await examples(gagId, "approved")).length, 0, "nothing was published");
    assert.deepEqual((await availableGags(factId)).map((g) => g.content.coreSceneOverride), [A.coreSceneOverride]);
  });
});

describe("grandfathering (Q11)", () => {
  it("a grandfathered gag stays offered while its draft gains examples, and stops being grandfathered when the draft is published", async () => {
    const { factId, gagId } = await liveFact();
    assert.equal((await gagRow(gagId)).approvedCarriedOver, true);

    for (const kind of ["male", "female"] as const) {
      await approve(factId, gagId, await render(factId, gagId, A, kind));
      const row = await gagRow(gagId);
      assert.equal(row.approvedCarriedOver || row.approvedBeforeExampleSets, true, `after the ${kind} pick it is still grandfathered`);
      assert.deepEqual(row.pendingContent, A, "the pick opened a draft of the same content");
      assert.deepEqual((await availableGags(factId)).map((g) => g.gagId), [gagId], "still offered");
    }
    const view = (await request(app).get(url(factId))).body.gags.find((g: { id: number }) => g.id === gagId);
    assert.equal(view.grandfathered, true);
    assert.equal(view.approvedExamples.male, null, "the published version has no examples yet");
    assert.notEqual(view.pendingExamples.male, null);
    assert.equal(view.pendingExamples.pet, null);

    await approve(factId, gagId, await render(factId, gagId, A, "pet"));
    assert.equal((await gagRow(gagId)).approvedCarriedOver, true, "a complete draft publishes nothing by itself");
    await describeDraftChanges(factId);
    await db.transaction((tx) => publishDraft(tx, factId, adminId));
    const row = await gagRow(gagId);
    assert.equal(row.approvedCarriedOver, false, "the marker ends with the first published complete set");
    assert.equal(row.approvedBeforeExampleSets, false);
    assert.deepEqual(row.approvedContent, A, "the content users get never changed");
    const offered = await availableGags(factId);
    assert.equal(offered.length, 1);
    assert.ok(GAG_EXAMPLE_KINDS.every((k) => offered[0]!.examples[k] != null), "offered with its three examples");
  });
});

describe("renders, counted per action", () => {
  it("one male render per content: A, then B, then back to A draws nothing new, and the tile shows A's render, approvable", async () => {
    const { factId, gagId } = await liveFact();
    const forA = drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId }));
    assert.equal(forA.length, 1);
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "the same content reuses its render");

    const B = scene("{NAME} lifts the sun (B).");
    await save(factId, gagId, B);
    const forB = drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId }));
    assert.equal(forB.length, 1, "B gets its own render");

    // Saving A again returns the gag to its published version in the draft.
    await save(factId, gagId, A);
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "back to A: A's render is reused");
    // The working render is the newest, B's, drawn from another version
    // (PLAN_RENDER_HISTORY.md D1); A's stays in the gag's history.
    const cards = await buildGagWorkingCards(gagId);
    assert.equal(cards.male!.latestAttemptId, forB[0]!.attemptId, "the working render is the newest");
    assert.equal(cards.male!.stale, true, "drawn from an earlier version");
    assert.equal(cards.female, null, "no female render yet");

    // A's render, once finished, is approvable as the male example.
    await db.update(imagePromptAttemptsTable).set({ generatedImageObjectPath: `/objects/ai-bg-v2/${factId}/a.png` })
      .where(eq(imagePromptAttemptsTable.id, forA[0]!.attemptId));
    await approve(factId, gagId, forA[0]!.attemptId);

    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId, redraw: true })).length, 1, "an explicit redraw draws a new one");
  });

  it("a classification edit keeps the render: the picture is drawn from the gag alone (Codex, PR #972 round 2; PLAN_GAG_DIRECT_RENDER.md, D)", async () => {
    const { factId, gagId } = await liveFact();
    const first = drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId }));
    assert.equal(first.length, 1);
    const base = buildPlaceholderFactEnrichment();
    // An admin note and a rating: neither reaches the picture.
    await db.update(factsTable).set({ enrichment: { ...base, adminReviewNotes: "a note written after seeing the render", adultSuitability: base.adultSuitability === "safe" ? "compatible" : "safe" } as never }).where(eq(factsTable.id, factId));
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "the render is reused");
    const kept = (await buildGagWorkingCards(gagId)).male!;
    assert.equal(kept.latestAttemptId, first[0]!.attemptId, "the tile still shows it");
    assert.equal(kept.stale, false, "a classification edit is not a new version of the picture");
    // A field the planner used to read: since the switch it shapes no picture either.
    await db.update(factsTable).set({ enrichment: { ...base, visualComplexity: base.visualComplexity === "high" ? "low" : "high" } as never }).where(eq(factsTable.id, factId));
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "the render is still reused");
  });

  it("a published example drawn from an earlier version of the content is the working render, out of date, until it is drawn again (Issue #1277; PLAN_RENDER_HISTORY.md D1)", async () => {
    // The published set was drawn before the cast fill wrote a cast into the
    // approved content (PLAN_GAG_DIRECT_RENDER.md, E): no render matches the
    // content as it is now, but the gag has a picture of every kind.
    const withACobra = withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "{NAME} is bitten by a king cobra." }, [{ label: "cobra", description: "a king cobra" }]);
    const f = await insertLiveFact({ text: `{NAME} example sets ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, withACobra);
    factIds.push(f.id);
    const factId = f.id;
    const gagId = f.gags[0]!.id;
    const { cast: _cast, castExtraction: _ext, ...beforeCastFill } = withACobra;
    const ids = {} as Record<GagExampleKind, number>;
    for (const k of GAG_EXAMPLE_KINDS) ids[k] = await render(factId, gagId, beforeCastFill as VisualPromptStrategyOverride, k);
    await db.transaction(async (tx) => {
      for (const k of GAG_EXAMPLE_KINDS) {
        await tx.insert(factGagExamplesTable).values({ gagId, subjectKind: k, stage: "approved", attemptId: ids[k], approvedBy: adminId });
      }
    });

    const cards = await buildGagWorkingCards(gagId);
    for (const k of GAG_EXAMPLE_KINDS) {
      assert.equal(cards[k]!.latestAttemptId, ids[k], `the ${k} tile shows the published ${k} example`);
      assert.equal(cards[k]!.status, "done");
      assert.ok(cards[k]!.imageUrl, `the ${k} tile has the picture`);
      assert.equal(cards[k]!.stale, true, `the ${k} tile reads out of date`);
    }

    // Drawn again for the content as it is: the new render takes the tile, current.
    const male = drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId, redraw: true }));
    assert.equal(male.length, 1);
    const after = await buildGagWorkingCards(gagId);
    assert.equal(after.male!.latestAttemptId, male[0]!.attemptId);
    assert.equal(after.male!.stale, false);
    assert.equal(after.female!.latestAttemptId, ids.female, "the other kinds keep their example");

    // A change in the draft: every working render now reads out of date,
    // the one just drawn included, until it is drawn again.
    await save(factId, gagId, scene("{NAME} lifts the sun (a change)."));
    const changed = await buildGagWorkingCards(gagId);
    assert.equal(changed.female!.stale, true, "the earlier version's render reads out of date");
    assert.equal(changed.male!.stale, true, "so does the render of the content before the change");
  });

  it("overlapping requests for the same content draw one render", async () => {
    const { gagId } = await liveFact();
    const [a, b] = await Promise.all([
      drawGagKinds(gagId, ["male"], { adminUserId: adminId }),
      drawGagKinds(gagId, ["male"], { adminUserId: adminId }),
    ]);
    assert.equal(drawn(a).length + drawn(b).length, 1);
    assert.equal((await attemptsOf(gagId)).length, 1);
  });

  it("\"render female and pet\" draws only what is missing, and never a retired scenario", async () => {
    const { gagId } = await liveFact();
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 1);
    const rest = drawn(await drawGagKinds(gagId, ["male", "female", "pet"], { adminUserId: adminId }));
    assert.deepEqual(rest.map((e) => e.scenarioKey).sort(), ["i2i_female_default", "i2i_nonhuman_animal"]);
    assert.equal(drawn(await drawGagKinds(gagId, ["female", "pet"], { adminUserId: adminId })).length, 0, "a second click draws nothing");
    const keys = new Set((await attemptsOf(gagId)).map((a) => a.key));
    assert.deepEqual([...keys].sort(), ["i2i_female_default", "i2i_male_default", "i2i_nonhuman_animal"]);
  });

  it("a failed render shows on its tile with its error, and an explicit redraw retries it", async () => {
    const { factId, gagId } = await liveFact();
    await render(factId, gagId, A, "male", { failed: true });
    const card = (await buildGagWorkingCards(gagId)).male!;
    assert.equal(card.status, "failed");
    assert.equal(card.message, "vendor failed");
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId, redraw: true })).length, 1);
  });

  it("the renders route draws the kinds asked for from a review, refuses an unknown kind, and refuses a live fact", async () => {
    const [f] = await db.insert(factsTable).values({ text: `{NAME} renders route ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(f!.id);
    const factId = f!.id;
    const [g] = await db.insert(factGagsTable).values({ factId, slot: 1, pendingContent: A }).returning({ id: factGagsTable.id });
    const gagId = g!.id;
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "renders", submittedById: adminId, status: "pending", workflowStage: "test_renders",
      stagingFactId: factId, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const ok = await request(app).post(url(factId, `/${gagId}/renders`)).send({ kinds: ["female", "pet"], reviewId: review!.id });
    assert.ok([200, 202].includes(ok.status), JSON.stringify(ok.body));
    assert.deepEqual((await attemptsOf(gagId)).map((a) => a.key).sort(), ["i2i_female_default", "i2i_nonhuman_animal"]);
    const liveOne = await liveFact();
    // An approved fact's renders are drawn from its fact sheet, which names no review (plan 3B).
    const liveDraw = await request(app).post(url(liveOne.factId, `/${liveOne.gagId}/renders`)).send({ kinds: ["male"] });
    assert.ok([200, 202].includes(liveDraw.status), JSON.stringify(liveDraw.body));
    assert.deepEqual((await attemptsOf(liveOne.gagId)).map((a) => a.key), ["i2i_male_default"]);
    const bad = await request(app).post(url(factId, `/${gagId}/renders`)).send({ kinds: ["vehicle"], reviewId: review!.id });
    assert.equal(bad.status, 400);
    const generic = await request(app).post(url(factId, `/${gagId}/renders`)).send({ scenarios: ["generic_t2i"] });
    assert.equal(generic.status, 400, "the retired scenario list is not accepted");

    // Back on the Gags step, which shows no renders, the route draws nothing (plan 1E).
    await db.update(pendingReviewsTable).set({ workflowStage: "gags" }).where(eq(pendingReviewsTable.id, review!.id));
    const onGags = await request(app).post(url(factId, `/${gagId}/renders`)).send({ kinds: ["male"], reviewId: review!.id });
    assert.equal(onGags.status, 409, JSON.stringify(onGags.body));
    assert.equal(onGags.body.code, "GAGS_STEP");
    assert.equal((await attemptsOf(gagId)).length, 2, "no render was bought on the Gags step");
  });
});

describe("the rules the database enforces at commit (7a)", () => {
  /** A live, no-longer-grandfathered gag with a complete published set. */
  async function completeGag() {
    const { factId, gagId } = await liveFact();
    for (const kind of GAG_EXAMPLE_KINDS) await approve(factId, gagId, await render(factId, gagId, A, kind));
    await describeDraftChanges(factId);
    await db.transaction((tx) => publishDraft(tx, factId, adminId));
    assert.equal((await gagRow(gagId)).approvedCarriedOver, false);
    return { factId, gagId };
  }
  // Drizzle wraps a commit-time refusal ("Failed query: commit"); the reason is its cause.
  const refusedBy = (re: RegExp) => (err: unknown) => {
    const e = err as { message?: string; cause?: { message?: string } };
    return re.test(`${e.message ?? ""} ${e.cause?.message ?? ""}`);
  };
  const refused = refusedBy(/without its male, female and pet examples/);

  it("refuses deleting an approved example", async () => {
    const { gagId } = await completeGag();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.delete(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.subjectKind, "pet")));
    }), refused);
    assert.equal((await examples(gagId, "approved")).length, 3);
  });

  it("refuses moving an approved example out of the approved set", async () => {
    const { gagId } = await completeGag();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.update(factGagExamplesTable).set({ stage: "pending" })
        .where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.subjectKind, "male")));
    }), refusedBy(/without its male, female and pet examples|pending examples without pending content/));
  });

  it("refuses clearing the grandfathered marker before the set is complete", async () => {
    const { gagId } = await liveFact();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.update(factGagsTable).set({ approvedCarriedOver: false, approvedBeforeExampleSets: false }).where(eq(factGagsTable.id, gagId));
    }), refused);
    assert.equal((await gagRow(gagId)).approvedCarriedOver, true);
  });

  it("accepts a set replaced whole in one transaction", async () => {
    const { factId, gagId } = await completeGag();
    const fresh = await Promise.all(GAG_EXAMPLE_KINDS.map((k) => render(factId, gagId, A, k)));
    await db.transaction(async (tx) => {
      await tx.delete(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, "approved")));
      await tx.insert(factGagExamplesTable).values(GAG_EXAMPLE_KINDS.map((k, i) => ({ gagId, subjectKind: k, stage: "approved" as const, attemptId: fresh[i]!, approvedBy: adminId })));
    });
    assert.deepEqual((await examples(gagId, "approved")).map((e) => e.attemptId).sort(), [...fresh].sort());
  });

  it("refuses a pending example with no pending content", async () => {
    const { factId, gagId } = await liveFact();
    const attemptId = await render(factId, gagId, A, "male");
    await assert.rejects(db.transaction(async (tx) => {
      await tx.insert(factGagExamplesTable).values({ gagId, subjectKind: "male", stage: "pending", attemptId, approvedBy: adminId });
    }), refusedBy(/pending examples without pending content/));
  });
});
});
