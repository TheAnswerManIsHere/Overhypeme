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
import { buildGagKindCards, drawGagKinds, reviewRenderScenariosPrepareHandler } from "../lib/reviewRenderScenarios.js";
import { pendingReviewsTable } from "@workspace/db/schema";
import { withCast } from "./helpers/gagCast.js";
import { approveGagRender, saveGagContent } from "../lib/gags/gagStore.js";
import { publishDraft } from "../lib/gags/publish.js";

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
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 1, "B gets its own render");

    // Saving A again returns the gag to its published version in the draft.
    await save(factId, gagId, A);
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "back to A: A's render is reused");
    const cards = await buildGagKindCards(gagId);
    assert.equal(cards.male!.latestAttemptId, forA[0]!.attemptId, "the tile shows A's render");
    assert.equal(cards.male!.stale, false);
    assert.equal(cards.female!.status, "missing");

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
    assert.equal((await buildGagKindCards(gagId)).male!.latestAttemptId, first[0]!.attemptId, "the tile still shows it");
    // A field the planner used to read: since the switch it shapes no picture either.
    await db.update(factsTable).set({ enrichment: { ...base, visualComplexity: base.visualComplexity === "high" ? "low" : "high" } as never }).where(eq(factsTable.id, factId));
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId })).length, 0, "the render is still reused");
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
    const card = (await buildGagKindCards(gagId)).male!;
    assert.equal(card.status, "failed");
    assert.equal(card.message, "vendor failed");
    assert.equal(drawn(await drawGagKinds(gagId, ["male"], { adminUserId: adminId, redraw: true })).length, 1);
  });

  it("a queued iteration render is skipped once the review its save came from has closed, and drawn while the scope holds (Codex, PR #972 round 1)", async () => {
    // A first-time submission in moderation: an inactive fact, its gag pending, its review open.
    const [f] = await db.insert(factsTable).values({ text: `{NAME} withdrawn ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(f!.id);
    const [g] = await db.insert(factGagsTable).values({ factId: f!.id, slot: 1, pendingContent: scene("{NAME} a gag saved, then withdrawn.") }).returning({ id: factGagsTable.id });
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "withdrawn", submittedById: adminId, status: "pending", workflowStage: "test_renders",
      stagingFactId: f!.id, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const job = { factId: f!.id, gagId: g!.id, scopeReviewId: review!.id, adminUserId: adminId };

    // Withdrawn before the job runs: the review is no longer open.
    await db.update(pendingReviewsTable).set({ status: "rejected" }).where(eq(pendingReviewsTable.id, review!.id));
    const skipped = await reviewRenderScenariosPrepareHandler.run(job, {} as never);
    assert.equal(skipped.ok, true);
    assert.equal((skipped as { result?: { skipped?: string } }).result?.skipped, "REVIEW_NOT_EDITABLE");
    assert.equal((await attemptsOf(g!.id)).length, 0, "no render was bought");

    // While the review is open the same job draws its one male render.
    await db.update(pendingReviewsTable).set({ status: "pending" }).where(eq(pendingReviewsTable.id, review!.id));
    const drawnJob = await reviewRenderScenariosPrepareHandler.run(job, {} as never);
    assert.equal(drawnJob.ok, true);
    assert.deepEqual((await attemptsOf(g!.id)).map((a) => a.key), ["i2i_male_default"]);
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.id, review!.id)).catch(() => undefined);
  });

  it("a live fact's queued iteration render is skipped once a refresh opens on it", async () => {
    const { factId, gagId } = await liveFact();
    const [review] = await db.insert(pendingReviewsTable).values({
      submittedText: "refresh", submittedById: adminId, status: "pending", workflowStage: "gags",
      stagingFactId: factId, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
    }).returning({ id: pendingReviewsTable.id });
    const result = await reviewRenderScenariosPrepareHandler.run({ factId, gagId, scopeReviewId: null, adminUserId: adminId }, {} as never);
    assert.equal(result.ok, true);
    assert.ok((result as { result?: { skipped?: string } }).result?.skipped, JSON.stringify(result));
    assert.equal((await attemptsOf(gagId)).length, 0);
    await db.delete(pendingReviewsTable).where(eq(pendingReviewsTable.id, review!.id));
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
    const refusedLive = await request(app).post(url(liveOne.factId, `/${liveOne.gagId}/renders`)).send({ kinds: ["male"] });
    assert.equal(refusedLive.status, 409);
    assert.equal(refusedLive.body.code, "LIVE_GAG_EDITING_UNAVAILABLE");
    const bad = await request(app).post(url(factId, `/${gagId}/renders`)).send({ kinds: ["vehicle"], reviewId: review!.id });
    assert.equal(bad.status, 400);
    const generic = await request(app).post(url(factId, `/${gagId}/renders`)).send({ scenarios: ["generic_t2i"] });
    assert.equal(generic.status, 400, "the retired scenario list is not accepted");
  });
});

describe("the rules the database enforces at commit (7a)", () => {
  /** A live, no-longer-grandfathered gag with a complete published set. */
  async function completeGag() {
    const { factId, gagId } = await liveFact();
    for (const kind of GAG_EXAMPLE_KINDS) await approve(factId, gagId, await render(factId, gagId, A, kind));
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
