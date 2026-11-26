/**
 * The gag lifecycle through its routes (plans docs/plans/PLAN_THREE_GAGS.md,
 * Testing Plan items 5, 6, 7, 9 and 10, and PLAN_FACT_LIFECYCLE_REBUILD.md,
 * 1E and 1F):
 *
 *   - every write is to the fact's draft and comes from its review; a write
 *     with no review is refused (a live fact's gags are not edited between
 *     phases);
 *   - approval refuses another gag's render, an unfinished or failed one, a
 *     styled one and one drawn from other content, and records the rest as
 *     draft picks; the draft meets the go-live rule once every gag has its
 *     male, female and pet picks;
 *   - every slot follows the same rules;
 *   - any gag can be removed, the last one included; a published gag is only
 *     removed in the draft;
 *   - nothing draws by itself: saving, adding and removing queue no job and
 *     start no render; a render is drawn only when an admin asks for it,
 *     male alone included (Issue #1282, plan PLAN_RENDERS_MANUAL.md).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable, factGagDescriptionsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { asyncJobsTable, imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";
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
import { availableGags, normaliseGagContent, primaryGag } from "../lib/gags/resolver.js";
import { GagError, approveGagRender, gagContentEqual, removeGag } from "../lib/gags/gagStore.js";
import { hasUnpublishedChanges, publishFactChanges } from "../lib/factLifecycle.js";
import { loadGagRenderTarget, reviewRenderStates } from "../lib/reviewRenderScenarios.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visualPromptStrategyOverrideSchema } from "@workspace/api-zod";
import { withCast } from "./helpers/gagCast.js";
import { __setDraftCastExtractorForTest } from "../lib/gags/castPreparation.js";
import { __setDescriptionDrafterForTest, gagContentFingerprint } from "../lib/gags/descriptions.js";
import { castSourceKey, PLACEHOLDER_CORE_SCENE_OVERRIDE } from "@workspace/api-zod";

const RUN = randomUUID().slice(0, 8);
const START = new Date();
const scene = (text: string): VisualPromptStrategyOverride => withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const A = scene("{NAME} lifts the moon (approved).");
const LISTS = ["requiredVisualDetails", "forbiddenVisualDetails", "roleBindings", "bubbles", "compositionGuidance", "styleAgnosticPromptAdditions", "negativePromptAdditions"] as const;

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

/**
 * A submission at the Gags step: an inactive fact never approved for
 * production, its review open at `stage`, and gag A in its draft.
 */
async function submission(stage: "gags" | "test_renders" = "gags"): Promise<{ factId: number; gagId: number; reviewId: number }> {
  const [f] = await db.insert(factsTable).values({ text: `{NAME} gags submission ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
  factIds.push(f!.id);
  const [g] = await db.insert(factGagsTable).values({ factId: f!.id, slot: 1, pendingContent: A as never }).returning({ id: factGagsTable.id });
  const [review] = await db.insert(pendingReviewsTable).values({
    submittedText: "submission", submittedById: adminId, status: "pending", workflowStage: stage,
    stagingFactId: f!.id, enrichment: buildPlaceholderFactEnrichment() as never, enrichmentStatus: "ok",
  }).returning({ id: pendingReviewsTable.id });
  return { factId: f!.id, gagId: g!.id, reviewId: review!.id };
}

async function liveFact(): Promise<{ factId: number; gagId: number }> {
  const f = await insertLiveFact({ text: `{NAME} gags test ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, A);
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id };
}

/** A test render of `gagId` that drew `content`, for a kind (male by default); finished unless told otherwise. */
/** Approve the description of a gag's draft content through the route, as a moderator does (Issue #1331). */
async function describeDraft(factId: number, gagId: number, reviewId?: number) {
  const view = await request(app).get(url(factId));
  const gag = (view.body.gags as Array<{ id: number; descriptions: { draft: { contentFingerprint: string } | null; published: { contentFingerprint: string } | null } }>).find((g) => g.id === gagId)!;
  const version = gag.descriptions.draft ?? gag.descriptions.published!;
  const res = await request(app).put(url(factId, `/${gagId}/description`))
    .send({ contentFingerprint: version.contentFingerprint, text: "{NAME} does it.", ...(reviewId ? { reviewId } : {}) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

async function render(factId: number, gagId: number, content: VisualPromptStrategyOverride, opts: { unfinished?: boolean; failed?: boolean; styled?: boolean; kind?: GagExampleKind | null } = {}): Promise<number> {
  const kind = opts.kind === undefined ? "male" : opts.kind;
  const [row] = await db.insert(imagePromptAttemptsTable).values({
    factId,
    gagId,
    reviewRenderScenarioKey: kind ? SCENARIO_FOR_KIND[kind] : "generic_t2i",
    renderJobId: randomUUID(),
    generationMode: "t2i",
    subjectRenderMode: "t2i_fallback",
    targetEngine: "nano_banana_2",
    sourceImageAnalysis: {} as never,
    identityPolicy: {} as never,
    renderControls: (opts.styled ? { styleId: "anime" } : {}) as never,
    factEnrichmentSnapshot: { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: content } as never,
    archetypeStrategyVersion: "v2",
    generatedImageObjectPath: opts.unfinished || opts.failed ? null : `/objects/ai-bg-v2/${factId}/${randomUUID()}.png`,
    error: opts.failed ? "vendor failed" : null,
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

const url = (factId: number, rest = "") => `/api/admin/facts/${factId}/gags${rest}`;

/** Approve a male, female and pet render of `content` as the gag's draft picks; returns the last response. */
async function approveSet(factId: number, gagId: number, content: VisualPromptStrategyOverride, reviewId: number) {
  let last: request.Response | null = null;
  for (const kind of GAG_EXAMPLE_KINDS) {
    last = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, content, { kind }), reviewId });
    assert.equal(last.status, 200, `${kind}: ${JSON.stringify(last.body)}`);
  }
  return last!;
}
const examplesOf = async (gagId: number, stage: "approved" | "pending") =>
  (await db.select().from(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, stage)))).length;
const gagRow = async (gagId: number) => (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
const offeredScenes = async (factId: number) => (await availableGags(factId)).map((g) => g.content.coreSceneOverride);
const jobsSinceStart = async () => (await db.select({ id: asyncJobsTable.id }).from(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START))).length;
/** Render attempts a fact has, across its gags: a render that started by itself would show here. */
const attemptsFor = async (factId: number) => (await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, factId))).length;
const jobsForGag = async (gagId: number) => (await db.select({ payload: asyncJobsTable.payload }).from(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START)))
  .filter((j) => (j.payload as { gagId?: number } | null)?.gagId === gagId).length;

before(async () => {
  adminId = `t-gags-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, gagsRouter);
});

after(async () => {
  if (factIds.length) {
    // Children before parents: gags point at renders and reviews, renders and
    // refresh candidates at reviews. Inactive first so the live-fact rule allows
    // deleting the gags.
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(asyncJobsTable).where(gte(asyncJobsTable.createdAt, START));
});

describe("gag routes: every write is to the draft, from a review", () => {
  it("a saved change stays in the draft, draws nothing, and the view says what the draft still needs", async () => {
    const { factId, gagId, reviewId } = await submission();
    const jobsBefore = await jobsForGag(gagId);
    const attemptsBefore = await attemptsFor(factId);
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} lifts the sun (change)."), reviewId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const view = res.body.gags.find((g: { id: number }) => g.id === gagId);
    assert.equal(view.state, "new");
    assert.equal(view.availableToUsers, false);
    assert.equal(res.body.draftReady.ok, false);
    assert.match(res.body.draftReady.reason, /Visual gag 1 needs male, female and pet renders approved/);
    assert.equal((await gagRow(gagId)).approvedContent, null, "nothing is published");
    assert.equal(await jobsForGag(gagId), jobsBefore, "saving queues no render job (Issue #1282)");
    assert.equal(await attemptsFor(factId), attemptsBefore, "saving starts no render");
  });

  // Plan 3B and the Testing Plan's journey "edit a live fact's gag →
  // unpublished → publish", through the real routes with no review named, as
  // the fact sheet sends them (PR #1227 round 1, Codex 4685554388).
  it("a live fact's gags are edited through the routes with no review: every write lands in the draft, members see none of it until Publish", async () => {
    const { factId, gagId } = await liveFact();
    const B = scene("{NAME} lifts two moons (draft).");
    const C = scene("{NAME} juggles the planets (new gag).");

    const saved = await request(app).put(url(factId, `/${gagId}`)).send({ content: B });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "a save changes nothing members see");
    assert.equal(await jobsForGag(gagId), 0, "the save queues no render: every render is asked for (Issue #1282)");
    assert.equal(await attemptsFor(factId), 0, "the save starts no render");

    const added = await request(app).post(url(factId)).send({ content: C });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const newGag = (added.body.gags as { id: number; slot: number }[]).find((g) => g.slot === 2)!;
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "an added gag is not offered");

    // No vendor call: the i2i reference upload is stubbed, as the render tests do.
    __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
    try {
      const drawn = await request(app).post(url(factId, `/${gagId}/renders`)).send({ kinds: ["female"] });
      assert.equal(drawn.status, 200, JSON.stringify(drawn.body));
    } finally {
      __setReferenceFalUploadForTest(null);
    }

    for (const kind of GAG_EXAMPLE_KINDS) {
      const approved = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, B, { kind }) });
      assert.equal(approved.status, 200, `${kind}: ${JSON.stringify(approved.body)}`);
    }
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride], "approved draft pictures are not offered");

    const removed = await request(app).post(url(factId, `/${newGag.id}/remove`)).send({});
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    // A changed gag also needs its description reviewed before it can publish (Issue #1331).
    assert.deepEqual(removed.body.draftReady, { ok: false, reason: "Visual gag 1 needs its description reviewed." });
    const described = await describeDraft(factId, gagId);
    assert.equal(described.body.draftReady.ok, true, JSON.stringify(described.body.draftReady));
    assert.equal(await hasUnpublishedChanges(factId), true);

    const published = await publishFactChanges(factId, adminId);
    assert.equal(published.kind, "done", JSON.stringify(published));
    assert.deepEqual(await offeredScenes(factId), [B.coreSceneOverride], "Publish swaps the draft in");
    assert.equal(await hasUnpublishedChanges(factId), false);
  });

  it("a write with no review is still refused on a fact in moderation, and on a fact never approved", async () => {
    const sub = await submission("gags");
    const inModeration = await request(app).put(url(sub.factId, `/${sub.gagId}`)).send({ content: scene("{NAME} a change.") });
    assert.equal(inModeration.status, 409, JSON.stringify(inModeration.body));
    assert.equal(inModeration.body.code, "REVIEW_NOT_EDITABLE");

    await db.update(pendingReviewsTable).set({ status: "rejected" }).where(eq(pendingReviewsTable.id, sub.reviewId));
    for (const r of [
      await request(app).put(url(sub.factId, `/${sub.gagId}`)).send({ content: scene("{NAME} a change.") }),
      await request(app).post(url(sub.factId)).send({ content: scene("{NAME} a new gag.") }),
      await request(app).post(url(sub.factId, `/${sub.gagId}/renders`)).send({ kinds: ["male"] }),
    ]) {
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, "REVIEW_NOT_EDITABLE");
      assert.match(r.body.error, /never approved/);
    }
    assert.equal((await gagRow(sub.gagId)).pendingContent != null, true);
  });

  it("approval refuses another gag's render, an unfinished, a failed or a styled render, and one of other content; three picks make the draft ready and publish nothing", async () => {
    const { factId, gagId, reviewId } = await submission();
    const change = scene("{NAME} lifts the sun (change).");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId })).status, 200);
    const other = await request(app).post(url(factId)).send({ content: scene("{NAME} a second gag."), reviewId });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    const otherId = other.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;

    const cases: Array<[string, number, number, string]> = [
      ["another gag's render", await render(factId, otherId, change), 404, "RENDER_NOT_APPROVABLE"],
      ["an unfinished render", await render(factId, gagId, change, { unfinished: true }), 409, "RENDER_NOT_APPROVABLE"],
      ["a failed render", await render(factId, gagId, change, { failed: true }), 409, "RENDER_NOT_APPROVABLE"],
      ["a styled render", await render(factId, gagId, change, { styled: true }), 409, "RENDER_NOT_APPROVABLE"],
      ["a render of other content", await render(factId, gagId, scene("{NAME} something else.")), 409, "CONTENT_CHANGED"],
      ["a render of a retired scenario", await render(factId, gagId, change, { kind: null }), 409, "RENDER_NOT_APPROVABLE"],
    ];
    for (const [name, attemptId, status, code] of cases) {
      const r = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId, reviewId });
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, name);
    }
    assert.equal(await examplesOf(gagId, "pending"), 0, "nothing refused was picked");

    const last = await approveSet(factId, gagId, change, reviewId);
    assert.equal(await examplesOf(gagId, "pending"), 3, "the three picks are the gag's draft examples");
    assert.equal(await examplesOf(gagId, "approved"), 0, "a pick publishes nothing");
    assert.equal((await gagRow(gagId)).approvedContent, null);
    assert.equal(last.body.draftReady.ok, false, "gag 2 still lacks its renders");
    await describeDraft(factId, gagId, reviewId);
    const afterDescription = await request(app).get(`${url(factId)}?reviewId=${reviewId}`);
    assert.match(afterDescription.body.draftReady.reason, /^Visual gag 2 needs/);
    await approveSet(factId, otherId, scene("{NAME} a second gag."), reviewId);
    const done = await describeDraft(factId, otherId, reviewId);
    assert.deepEqual(done.body.draftReady, { ok: true, reason: null }, "every gag has its set and its description: the draft is ready");
  });
});

describe("gag routes: every slot follows the same rules", () => {
  for (const slot of [2, 3]) {
    it(`a gag added in slot ${slot} is a draft gag with picks of its own`, async () => {
      const { factId, reviewId } = await submission();
      if (slot === 3) {
        const s2 = await request(app).post(url(factId)).send({ content: scene("{NAME} slot two."), slot: 2, reviewId });
        assert.equal(s2.status, 200, JSON.stringify(s2.body));
      }
      const content = scene(`{NAME} slot ${slot}.`);
      const res = await request(app).post(url(factId)).send({ content, slot, reviewId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const created = res.body.gags.find((g: { slot: number }) => g.slot === slot);
      assert.equal(created.state, "new");
      assert.equal(created.availableToUsers, false);
      await approveSet(factId, created.id, content, reviewId);
      assert.equal(await examplesOf(created.id, "pending"), 3);
    });
  }

  it("refuses a fourth gag", async () => {
    const { factId, reviewId } = await submission();
    for (const s of [2, 3]) assert.equal((await request(app).post(url(factId)).send({ content: scene(`{NAME} ${s}.`), reviewId })).status, 200);
    const fourth = await request(app).post(url(factId)).send({ content: scene("{NAME} four."), reviewId });
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.code, "GAG_LIMIT");
  });
});

describe("the default gag: approved first, across every slot", () => {
  it("a draft-only gag in a freed lower slot does not displace the published one above it", async () => {
    const content = scene("{NAME} the approved slot-2 gag.");
    const f = await insertLiveFact({ text: `{NAME} default ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, A);
    factIds.push(f.id);
    const factId = f.id;
    const [second] = await db.insert(factGagsTable).values({ factId, slot: 2, approvedContent: content as never, approvedCarriedOver: true }).returning({ id: factGagsTable.id });
    const secondId = second!.id;
    await db.update(factGagsTable).set({ removedAt: new Date() }).where(eq(factGagsTable.id, f.gags[0]!.id));
    // A new gag takes the freed slot 1, in the draft only.
    await db.insert(factGagsTable).values({ factId, slot: 1, pendingContent: scene("{NAME} pending in slot 1.") as never });

    const primary = await primaryGag(factId);
    assert.equal(primary!.gag.id, secondId, "the default is the approved gag, not the lower-slot pending one");
    assert.equal(primary!.content.coreSceneOverride, content.coreSceneOverride);
    assert.equal((await availableGags(factId))[0]!.gagId, secondId, "and it agrees with the list a picker reads");
  });

  it("a fact with nothing approved falls back to its lowest-slot pending gag", async () => {
    const [fact] = await db.insert(factsTable).values({ text: `{NAME} staging ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(fact!.id);
    await db.insert(factGagsTable).values([
      { factId: fact!.id, slot: 2, pendingContent: scene("{NAME} pending two.") as never },
      { factId: fact!.id, slot: 1, pendingContent: scene("{NAME} pending one.") as never },
    ]);
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, "{NAME} pending one.");
  });

  it("the stand-in scene a migration stamped is not a gag to draw: its pending change wins, then a real approved gag (bug: the comparison judged \"stands there confidently\")", async () => {
    // Approved for production on record: its gags hold published content (0157).
    const [fact] = await db.insert(factsTable).values({ text: `{NAME} stand-in ${RUN} ${randomUUID().slice(0, 6)}`, isActive: false, approvedAt: new Date(), approvalSource: "legacy", enrichment: buildPlaceholderFactEnrichment() as never }).returning({ id: factsTable.id });
    factIds.push(fact!.id);
    const standIn = scene(PLACEHOLDER_CORE_SCENE_OVERRIDE);
    // Fact 41's shape: the only gag's approved version is the stand-in, the real scene is pending.
    // Approved before examples existed, as the backfilled stand-ins were (the examples trigger allows that).
    const carried = { approvedCarriedOver: true, approvedBeforeExampleSets: true } as const;
    await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, approvedContent: standIn as never, ...carried, pendingContent: scene("{NAME} drives mom home.") as never });
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, "{NAME} drives mom home.", "the pending real scene, not the stand-in");
    // A real approved gag in a later slot beats both.
    await db.insert(factGagsTable).values({ factId: fact!.id, slot: 2, approvedContent: scene("{NAME} real approved.") as never, ...carried });
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, "{NAME} real approved.");
    // With nothing else, the stand-in is still returned, as before.
    await db.delete(factGagsTable).where(eq(factGagsTable.factId, fact!.id));
    await db.insert(factGagsTable).values({ factId: fact!.id, slot: 1, approvedContent: standIn as never, ...carried });
    assert.equal((await primaryGag(fact!.id))!.content.coreSceneOverride, PLACEHOLDER_CORE_SCENE_OVERRIDE);
  });
});

describe("a gag the migration carried over can be approved (Codex, PR #956 round 2)", () => {
  it("a render of a carried-over gag in its legacy shape is approved as a draft pick, and a render of other content is still refused", async () => {
    // The shape migration 0139 moves byte for byte: no defaulted lists, a retired key.
    const legacy = { version: 1, enabled: true, coreSceneOverride: "{NAME} lifts the moon (legacy shape)." };
    const f = await insertLiveFact({ text: `{NAME} legacy ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, legacy as never);
    factIds.push(f.id);
    const gagId = f.gags[0]!.id;
    // The snapshot a real render stores: the render target the loader builds.
    const loaded = await loadGagRenderTarget(gagId);
    assert.ok(loaded.ok, JSON.stringify(loaded));
    const drew = (loaded as { target: { enrichment: { visualPromptStrategyOverride: unknown } } }).target.enrichment.visualPromptStrategyOverride;
    const [real] = await db.insert(imagePromptAttemptsTable).values({
      factId: f.id, gagId, reviewRenderScenarioKey: "i2i_male_default", renderJobId: randomUUID(), generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano_banana_2",
      sourceImageAnalysis: {} as never, identityPolicy: {} as never, renderControls: {} as never,
      factEnrichmentSnapshot: (loaded as { target: { enrichment: unknown } }).target.enrichment as never,
      archetypeStrategyVersion: "v2", generatedImageObjectPath: `/objects/ai-bg-v2/${f.id}/${randomUUID()}.png`,
    }).returning({ id: imagePromptAttemptsTable.id });
    assert.notDeepEqual(drew, legacy, "precondition: the snapshot is the normalised form, not the stored one");

    // A live fact's gag, worked on through the store: the routes refuse a
    // write with no review between phases.
    const live = { adminId, reviewId: null };
    await assert.rejects(approveGagRender(f.id, gagId, await render(f.id, gagId, scene("{NAME} a different scene.")), live),
      (e: unknown) => e instanceof GagError && e.code === "CONTENT_CHANGED", "a render of other content is still refused");
    await approveGagRender(f.id, gagId, real!.id, live);
    const [ex] = await db.select().from(factGagExamplesTable).where(and(eq(factGagExamplesTable.gagId, gagId), eq(factGagExamplesTable.stage, "pending")));
    assert.equal(ex?.attemptId, real!.id, "the render is the gag's male draft pick");
    assert.equal((await gagRow(gagId)).approvedCarriedOver, true, "the published gag stays grandfathered");
  });

  it("every schema-valid gag in the legacy fixture is equal to its own normalised form", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rows = readFileSync(path.join(here, "../../fixtures/legacy/fact_gags.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    let checked = 0;
    for (const r of rows) {
      for (const c of [r["approved_content"], r["pending_content"]]) {
        if (c == null) continue;
        const parsed = visualPromptStrategyOverrideSchema.safeParse(c);
        if (!parsed.success) continue;
        assert.ok(gagContentEqual(c, parsed.data), `fixture gag ${String(r["id"])} differs from its normalised form`);
        checked++;
      }
    }
    assert.ok(checked > 40, `checked ${checked}`);
  });

  it("every gag in the legacy fixture reads as editor content, the schema-refused one included", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rows = readFileSync(path.join(here, "../../fixtures/legacy/fact_gags.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    let refused = 0;
    for (const r of rows) {
      for (const c of [r["approved_content"], r["pending_content"]]) {
        if (c == null) continue;
        const read = normaliseGagContent(c)!;
        for (const key of LISTS) assert.ok(Array.isArray(read[key]), `fixture gag ${String(r["id"])}: ${key} is not a list`);
        if (!visualPromptStrategyOverrideSchema.safeParse(c).success) {
          refused++;
          assert.equal(read.coreSceneOverride, (c as { coreSceneOverride?: string }).coreSceneOverride, "refused content keeps its text");
        }
      }
    }
    assert.ok(refused >= 1, "the fixture still carries schema-refused content, so the never-refuse path is exercised");
  });

  it("the Gags view fills an older stored shape's lists and returns refused content as stored (Codex, PR #956 round 3)", async () => {
    const legacy = { version: 1, enabled: true, coreSceneOverride: "{NAME} lifts the moon (older shape)." };
    const f = await insertLiveFact({ text: `{NAME} older shape ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, legacy as never);
    factIds.push(f.id);
    const gagId = f.gags[0]!.id;
    const refusedChange = { version: 1, coreSceneOverride: "{NAME} meets {BOGUS_TOKEN}." };
    await db.update(factGagsTable).set({ pendingContent: refusedChange as never }).where(eq(factGagsTable.id, gagId));

    const res = await request(app).get(url(f.id));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const view = (res.body.gags as Array<{ id: number; approvedContent: Record<string, unknown>; pendingContent: Record<string, unknown> }>).find((g) => g.id === gagId)!;
    for (const key of LISTS) {
      assert.deepEqual(view.approvedContent[key], [], `approved ${key}`);
      assert.deepEqual(view.pendingContent[key], [], `pending ${key}`);
    }
    assert.equal(view.approvedContent["coreSceneOverride"], legacy.coreSceneOverride);
    assert.equal(view.pendingContent["coreSceneOverride"], refusedChange.coreSceneOverride, "refused content keeps its text for the moderator to fix");
    assert.deepEqual((await gagRow(gagId)).approvedContent, legacy, "reading changes nothing stored");
    const offered = await availableGags(f.id);
    assert.ok(Array.isArray(offered[0]!.content.roleBindings), "the available-gags list is normalised too");
  });
});

describe("gag routes: remove", () => {
  it("removes any gag of a submission, the last one included, and the draft then needs a gag", async () => {
    const { factId, gagId, reviewId } = await submission();
    const jobsBefore = await jobsSinceStart();
    const removed = await request(app).post(url(factId, `/${gagId}/remove`)).send({ reviewId });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.notEqual((await gagRow(gagId)).removedAt, null);
    assert.deepEqual(removed.body.draftReady, { ok: false, reason: "A fact needs at least one visual gag before it can go live." });
    assert.equal(await jobsSinceStart(), jobsBefore, "removing spends nothing");
  });

  it("removes a published gag only in the draft: it stays offered until the draft is published", async () => {
    const { factId, gagId } = await liveFact();
    const row = await removeGag(factId, gagId, { adminId, reviewId: null });
    assert.equal(row.draftRemoved, true);
    assert.equal(row.removedAt, null);
    assert.deepEqual(await offeredScenes(factId), [A.coreSceneOverride]);
  });
});

describe("gag routes: while a review is open, gags change only inside it", () => {
  it("refuses a change naming another review, and accepts it from the fact's own", async () => {
    const { factId, gagId, reviewId } = await submission();
    const other = await submission();
    const change = scene("{NAME} the review's change.");

    const outside = await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId: other.reviewId });
    assert.equal(outside.status, 409);
    assert.equal(outside.body.code, "REVIEW_NOT_EDITABLE");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId })).status, 200);
  });

  // Issue #1282: no render starts by itself at Test Renders either; the
  // one way a render starts is the admin asking for it, male alone included.
  it("at Test Renders, adding and saving a gag draw nothing, and a render starts only when asked for, male alone included", async () => {
    const { factId, gagId, reviewId } = await submission("test_renders");
    const jobsBefore = await jobsSinceStart();
    const added = await request(app).post(url(factId)).send({ content: scene("{NAME} a second gag."), reviewId });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} the first gag, changed."), reviewId })).status, 200);
    assert.equal(await attemptsFor(factId), 0, "adding and saving start no render");
    assert.equal(await jobsSinceStart(), jobsBefore, "and queue no job");

    // No vendor call: the i2i reference upload is stubbed, as the render tests do.
    __setReferenceFalUploadForTest(async () => "https://fal.test/ref.jpg");
    try {
      const drawn = await request(app).post(url(factId, `/${secondId}/renders`)).send({ kinds: ["male"], reviewId });
      assert.equal(drawn.status, 200, JSON.stringify(drawn.body));
    } finally {
      __setReferenceFalUploadForTest(null);
    }
    const attempts = await db.select({ gagId: imagePromptAttemptsTable.gagId, key: imagePromptAttemptsTable.reviewRenderScenarioKey, controls: imagePromptAttemptsTable.renderControls })
      .from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.factId, factId));
    assert.deepEqual(attempts.map(({ gagId, key }) => ({ gagId, key })), [{ gagId: secondId, key: "i2i_male_default" }], "exactly the male render asked for, on the gag it was asked for");
    // Image tracing: the render names the admin who asked for it, never "system" (moved here from imageProvenance.test.ts).
    assert.equal((attempts[0]!.controls as { reviewAudit?: { adminUserId?: string } }).reviewAudit?.adminUserId, adminId);
  });

  it("the list's render state counts each gag that is not removed: one finishing never hides another (Codex, PR #956 round 2)", async () => {
    const { factId, gagId, reviewId } = await submission("test_renders");
    const added = await request(app).post(url(factId)).send({ content: scene("{NAME} gag two."), reviewId });
    const secondId = added.body.gags.find((g: { slot: number }) => g.slot === 2).id as number;
    const attempt = async (gid: number, state: "running" | "failed" | "done", at: string) => {
      await db.insert(imagePromptAttemptsTable).values({
        factId, gagId: gid, reviewId, reviewRenderScenarioKey: "i2i_male_default", renderJobId: randomUUID(),
        generationMode: "t2i", subjectRenderMode: "t2i_fallback", targetEngine: "nano_banana_2",
        sourceImageAnalysis: {} as never, identityPolicy: {} as never, renderControls: {} as never,
        factEnrichmentSnapshot: {} as never, archetypeStrategyVersion: "v2",
        generatedImageObjectPath: state === "done" ? `/objects/x/${randomUUID()}.png` : null,
        error: state === "failed" ? "vendor failed" : null, createdAt: new Date(at),
      });
    };
    // The earlier gag still drawing, the later one finished.
    await attempt(gagId, "running", "2026-01-01T00:00:00Z");
    await attempt(secondId, "done", "2026-01-01T00:01:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "running");
    // The earlier gag failed (a newer attempt of it), the later one finished.
    await attempt(gagId, "failed", "2026-01-01T00:02:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "needs_attention");
    // A superseded failure of a gag does not poison its later success.
    await attempt(gagId, "done", "2026-01-01T00:03:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "ready");
    // A removed gag is no longer counted.
    await attempt(secondId, "failed", "2026-01-01T00:04:00Z");
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "needs_attention");
    await db.update(factGagsTable).set({ removedAt: new Date() }).where(eq(factGagsTable.id, secondId));
    assert.equal((await reviewRenderStates([reviewId])).get(reviewId), "ready");
  });

  it("editing after picking cancels the pick", async () => {
    const { factId, gagId, reviewId } = await submission();
    const change = scene("{NAME} picked.");
    await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId });
    await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: await render(factId, gagId, change), reviewId });
    assert.equal(await examplesOf(gagId, "pending"), 1);
    await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} edited after the pick."), reviewId });
    assert.equal(await examplesOf(gagId, "pending"), 0, "the pick was for content the gag no longer holds");
  });
});

describe("gag routes: only admins", () => {
  it("refuses a signed-out caller", async () => {
    const { factId } = await liveFact();
    const anon = buildTestApp({ kind: "unauthenticated" }, gagsRouter);
    const res = await request(anon).get(url(factId));
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });
});


describe("gag routes: a save carries the cast read from its own scene (plan PLAN_GAG_DIRECT_RENDER.md, C and F)", () => {
  const bare = (text: string, bubbles: VisualPromptStrategyOverride["bubbles"] = []): VisualPromptStrategyOverride =>
    ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text, bubbles });

  it("refuses a save with no cast, and stores nothing", async () => {
    const { factId, gagId, reviewId } = await submission();
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: bare("{NAME} juggles planets."), reviewId });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CAST_MISSING");
    assert.deepEqual((await gagRow(gagId)).pendingContent, A, "the draft is unchanged");
  });

  it("refuses a cast read from a different scene", async () => {
    const { factId, gagId, reviewId } = await submission();
    const stale = { ...withCast(bare("{NAME} juggles planets.")), coreSceneOverride: "{NAME} juggles moons." };
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: stale, reviewId });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CAST_STALE");
  });

  it("refuses a bubble whose speaker the cast does not bind, naming the speaker", async () => {
    const { factId, gagId, reviewId } = await submission();
    const content = withCast(bare("{NAME} juggles planets alone.", [{ type: "speech", entity: "mom", text: "Careful!" }]));
    const unbound = { ...content, cast: [] };
    const res = await request(app).put(url(factId, `/${gagId}`)).send({ content: unbound, reviewId });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SPEAKER_NOT_IN_SCENE");
    assert.deepEqual(res.body.details, { speakers: ["mom"] });
  });

  it("stores the cast with the change, an empty cast told apart from none", async () => {
    const { factId, gagId, reviewId } = await submission();
    const withSpeaker = withCast(bare("{NAME} juggles planets; mom watches.", [{ type: "speech", entity: "mom", text: "Careful!" }]));
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: withSpeaker, reviewId })).status, 200);
    const stored = normaliseGagContent((await gagRow(gagId)).pendingContent)!;
    assert.deepEqual(stored.cast, [{ label: "mom", description: "the mom in the scene" }]);
    const empty = withCast(bare("{NAME} juggles planets alone."));
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: empty, reviewId })).status, 200);
    const storedEmpty = normaliseGagContent((await gagRow(gagId)).pendingContent)!;
    assert.deepEqual(storedEmpty.cast, []);
    assert.ok(storedEmpty.castExtraction, "an empty cast keeps its marker: extracted, nobody else there");
  });

  it("approves a render that drew the same scene, bubbles and cast entries, whatever extraction marker it froze; a different cast is a different picture (Codex 4600565971; PLAN_GAG_DIRECT_RENDER.md, D)", async () => {
    const { factId, gagId, reviewId } = await submission();
    const change = scene("{NAME} juggles planets (cast era).");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: change, reviewId })).status, 200);
    const { cast: _c, castExtraction: _m, ...beforeCasts } = change;
    const old = await render(factId, gagId, beforeCasts as VisualPromptStrategyOverride, { kind: "male" });
    assert.equal((await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: old, reviewId })).status, 200, "a render from before casts, of a gag whose cast is empty");
    const otherMarker = await render(factId, gagId, { ...change, castExtraction: { ...change.castExtraction!, promptVersion: "older", extractedAt: "2026-11-01T00:00:00.000Z" } }, { kind: "female" });
    assert.equal((await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: otherMarker, reviewId })).status, 200, "the same cast read at another time");
    const otherCast = await render(factId, gagId, { ...change, cast: [{ label: "dog", description: "a dog" }] }, { kind: "female" });
    const castRefused = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: otherCast, reviewId });
    assert.equal(castRefused.status, 409, "a render that drew a different cast is refused: the cast reaches the picture");
    assert.equal(castRefused.body.code, "CONTENT_CHANGED");
    const otherScene = await render(factId, gagId, scene("{NAME} juggles moons."), { kind: "pet" });
    const refused = await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: otherScene, reviewId });
    assert.equal(refused.status, 409, "a different picture is still refused");
    assert.equal(refused.body.code, "CONTENT_CHANGED");
  });

  it("a scene changed and changed back, its cast read again, keeps its render approvable", async () => {
    const { factId, gagId, reviewId } = await submission();
    const a = scene("{NAME} juggles planets, round trip.");
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: a, reviewId })).status, 200);
    const drawn = await render(factId, gagId, a, { kind: "male" });
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: scene("{NAME} juggles moons, briefly."), reviewId })).status, 200);
    const reread = { ...a, cast: [], castExtraction: { ...a.castExtraction!, extractedAt: "2026-11-18T09:00:00.000Z" } };
    assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: reread, reviewId })).status, 200);
    assert.equal((await request(app).post(url(factId, `/${gagId}/approve`)).send({ attemptId: drawn, reviewId })).status, 200);
  });
});

describe("gag routes: reading a draft's cast stores nothing (plan PLAN_GAG_DIRECT_RENDER.md, F)", () => {
  it("returns the cast, its marker and any unbound speaker, passing the fact's labels, and writes no gag", async () => {
    const { factId, gagId } = await liveFact();
    const seen: unknown[] = [];
    const restore = __setDraftCastExtractorForTest(async (input) => {
      seen.push(input);
      return {
        cast: [{ label: "mom", description: "the woman in the passenger seat" }],
        unboundSpeakers: ["nurse"],
        extraction: { promptVersion: "v2", extractedAt: "2026-11-17T00:00:00.000Z", sourceKey: castSourceKey(input.scene, input.bubbles) },
      };
    });
    try {
      const before = await gagRow(gagId);
      const bubbles = [{ type: "speech" as const, entity: "mom", text: "Slow!" }, { type: "speech" as const, entity: "nurse", text: "Hi" }];
      const res = await request(app).post(url(factId, "/cast")).send({ scene: "{NAME} drives; mom grips the dash.", bubbles });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.cast, [{ label: "mom", description: "the woman in the passenger seat" }]);
      assert.deepEqual(res.body.unboundSpeakers, ["nurse"]);
      assert.equal(res.body.castExtraction.sourceKey, castSourceKey("{NAME} drives; mom grips the dash.", bubbles));
      assert.equal((seen[0] as { scene: string }).scene, "{NAME} drives; mom grips the dash.");
      assert.ok(Array.isArray((seen[0] as { factCharacterLabels: unknown }).factCharacterLabels));
      assert.deepEqual(await gagRow(gagId), before, "nothing stored");
    } finally {
      restore();
    }
  });

  it("answers a failed reading as a failure, never an empty cast", async () => {
    const { factId } = await liveFact();
    const restore = __setDraftCastExtractorForTest(async () => { throw new Error("model down"); });
    try {
      const res = await request(app).post(url(factId, "/cast")).send({ scene: "{NAME} drives.", bubbles: [] });
      assert.equal(res.status, 502);
      assert.equal(res.body.code, "CAST_FAILED");
      assert.equal(res.body.cast, undefined);
    } finally {
      restore();
    }
  });

  it("refuses an empty scene and an unknown fact", async () => {
    assert.equal((await request(app).post(url(999999999, "/cast")).send({ scene: "x", bubbles: [] })).status, 404);
    const { factId } = await liveFact();
    assert.equal((await request(app).post(url(factId, "/cast")).send({ scene: "", bubbles: [] })).status, 400);
  });
});

// Plan PLAN_PHASE7_AI_PICTURE_FLOW.md, *Descriptions*: drafting "runs after
// any gag content write and on a schedule" (David, Q16: 1, 2026-11-26).
describe("a gag content write drafts its description straight away", () => {
  it("a saved change's new content gets an unreviewed AI draft without waiting for the schedule", async () => {
    __setDescriptionDrafterForTest(async (content) => `{NAME} drafted for: ${content.coreSceneOverride?.slice(0, 40)}`);
    try {
      const { factId, gagId } = await liveFact();
      const B = scene(`{NAME} lifts the sun ${randomUUID().slice(0, 6)}.`);
      assert.equal((await request(app).put(url(factId, `/${gagId}`)).send({ content: B })).status, 200);
      const fp = gagContentFingerprint(B)!;
      let row: typeof factGagDescriptionsTable.$inferSelect | undefined;
      for (let i = 0; i < 50 && !row?.text; i++) {
        await new Promise((r) => setTimeout(r, 100));
        [row] = await db.select().from(factGagDescriptionsTable)
          .where(and(eq(factGagDescriptionsTable.gagId, gagId), eq(factGagDescriptionsTable.contentFingerprint, fp)));
      }
      assert.ok(row?.text?.startsWith("{NAME} drafted for:"), `drafted after the write: ${JSON.stringify(row)}`);
      assert.equal(row!.reviewedAt, null, "a draft is unreviewed");
    } finally {
      __setDescriptionDrafterForTest(null);
    }
  });
});
