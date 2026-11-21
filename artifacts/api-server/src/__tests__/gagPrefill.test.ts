/**
 * Gag 1 pre-filled from the first idea, and a changed note replacing untouched
 * pre-filled gags (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 9, item 7 and
 * 1C; Issue #1018, increment 1.3b; lib/gags/prefill.ts):
 *   - on the Gags step, a fact with no gag gets gag 1 from the first usable
 *     idea, its cast read, recording the idea it came from;
 *   - a gag the moderator saved first is never replaced;
 *   - ideas written under a changed note replace every gag still exactly the
 *     idea it was filled from, dropping its draft picks; a gag edited by hand
 *     is kept;
 *   - ideas written again under the same note replace nothing;
 *   - nothing is filled off the Gags step;
 *   - saving a changed note writes fresh ideas by itself; saving the same
 *     note does not;
 *   - a gag still exactly its idea is left out of the gag writer's context,
 *     so pre-filling does not mark the ideas out of date.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { and, asc, eq, inArray, isNull, like } from "drizzle-orm";
import { db, factGagsTable, factsTable, usersTable } from "@workspace/db";
import { activityFeedTable, adminActionsTable, asyncJobsTable, factReadingsTable, pendingReviewsTable } from "@workspace/db/schema";
import { castSourceKey as castKey, type FactReadingResult, type StoredCandidateConcept, type VisualConceptCandidatesBlob } from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { latestReading, runReadingJob } from "../lib/readingJobs.js";
import { GAG_PREFILL_QUEUE, enqueueGagPrefill, runGagPrefill, type GagPrefillDeps } from "../lib/gags/prefill.js";
import { contextGagsFor } from "../lib/visualConceptJobs.js";
import { saveGagContent } from "../lib/gags/gagStore.js";
import { buildFactGagsView } from "../lib/gags/gagView.js";
import { insertExampleRender } from "./helpers/gagExampleSets.js";
import { factGagExamplesTable } from "@workspace/db/schema";

const RUN = randomUUID().slice(0, 8);
let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const reviewIds: number[] = [];

const NOTE = "Normally people watch sharks; here the sharks hold a week for Alex.";
const RESULT: FactReadingResult = { references: [], humorNote: NOTE };

const url = (id: number, rest: string) => `/api/admin/reviews/${id}/${rest}`;

/** A cast reader that binds every speaker and names nobody else. */
const castStub: GagPrefillDeps = {
  readCast: async (_factId, body) => ({
    cast: body.bubbles.filter((b) => b.text.trim()).map((b) => ({ label: b.entity, description: `the ${b.entity} beside the subject` })),
    castExtraction: { promptVersion: "v2", extractedAt: new Date().toISOString(), sourceKey: castKey(body.scene, body.bubbles) },
    unboundSpeakers: [],
  }),
};

function idea(i: number, tag: string, opts: { pickable?: boolean } = {}): StoredCandidateConcept {
  return {
    title: `Idea ${i}`,
    whyItWorks: "Because.",
    sceneDescription: `{NAME} does thing ${i} (${tag}).`,
    tokenValid: opts.pickable ?? true,
    bubbles: [],
  };
}

/** Store ideas on the fact as the ideas job would. */
async function storeIdeas(reviewId: number, factId: number, ideas: StoredCandidateConcept[], note: string | null): Promise<VisualConceptCandidatesBlob> {
  const blob: VisualConceptCandidatesBlob = {
    candidates: ideas,
    generatedAt: new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString(),
    provenance: { engineId: "stub", model: "stub", reasoningEffort: null, timeoutMs: 1, promptVersion: 6 } as never,
    reviewId,
    source: "staging_fact",
    inputHash: "stub",
    humorNoteUsed: note,
  };
  await db.update(factsTable).set({ visualConceptCandidates: blob, visualConceptStatus: "ok" }).where(eq(factsTable.id, factId));
  return blob;
}

const gagsOf = (factId: number) => db.select().from(factGagsTable)
  .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt))).orderBy(asc(factGagsTable.slot));
const prefillJobs = (reviewId: number) => db.select({ id: asyncJobsTable.id, payload: asyncJobsTable.payload }).from(asyncJobsTable)
  .where(and(eq(asyncJobsTable.queue, GAG_PREFILL_QUEUE), like(asyncJobsTable.dedupeKey, `${GAG_PREFILL_QUEUE}:${reviewId}:%`)));
const ideaJobs = (reviewId: number) => db.select({ id: asyncJobsTable.id }).from(asyncJobsTable)
  .where(like(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${reviewId}:%`));
const sceneOf = (g: { pendingContent: unknown; approvedContent: unknown }) =>
  ((g.pendingContent ?? g.approvedContent) as { coreSceneOverride?: string } | null)?.coreSceneOverride;

/** A submission accepted, read and approved: at Gags, no gag yet. */
async function atGags(): Promise<{ reviewId: number; factId: number }> {
  const [row] = await db.insert(pendingReviewsTable).values({
    submittedText: `{NAME} has a Shark Week of their own ${RUN} ${randomUUID().slice(0, 6)}.`, submittedById: adminId, status: "pending", workflowStage: "triage",
  }).returning({ id: pendingReviewsTable.id });
  reviewIds.push(row!.id);
  const accepted = await request(app).post(url(row!.id, "provisional-approve")).send({});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const factId: number = accepted.body.stagingFactId;
  const run = (await latestReading(factId))!;
  await runReadingJob({ readingId: run.id }, { read: async () => ({ result: RESULT, provenance: { model: "stub" } }) });
  const approved = await request(app).post(url(row!.id, "approve-reading")).send({ text: NOTE, readingId: run.id });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { reviewId: row!.id, factId };
}

const prefill = (reviewId: number, factId: number) => runGagPrefill({ reviewId, factId, adminId }, castStub);

before(async () => {
  adminId = `t-prefill-admin-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, reviewsRouter);
  app.locals["duplicateDetector"] = async () => ({ outcome: "distinct" as const, confidence: 0 });
});

after(async () => {
  const reviews = reviewIds.length ? await db.select({ stagingFactId: pendingReviewsTable.stagingFactId }).from(pendingReviewsTable).where(inArray(pendingReviewsTable.id, reviewIds)) : [];
  const factIds = reviews.map((r) => r.stagingFactId).filter((x): x is number => x != null);
  for (const id of reviewIds) {
    await db.delete(asyncJobsTable).where(like(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${id}:%`));
    await db.delete(asyncJobsTable).where(like(asyncJobsTable.dedupeKey, `${GAG_PREFILL_QUEUE}:${id}:%`));
  }
  if (factIds.length) {
    const runs = await db.select({ id: factReadingsTable.id }).from(factReadingsTable).where(inArray(factReadingsTable.factId, factIds));
    for (const r of runs) await db.delete(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `fact_reading:${r.id}`));
    for (const f of factIds) await db.delete(asyncJobsTable).where(eq(asyncJobsTable.dedupeKey, `enrichment:fact:${f}`));
  }
  await db.delete(adminActionsTable).where(eq(adminActionsTable.actorId, adminId));
  if (reviewIds.length) await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.id, reviewIds));
  if (factIds.length) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  await db.delete(activityFeedTable).where(eq(activityFeedTable.userId, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("gag 1 from the first idea", () => {
  it("approving the reading asks for it, and the first usable idea becomes gag 1 with its cast and its source recorded", async () => {
    const { reviewId, factId } = await atGags();
    assert.equal((await prefillJobs(reviewId)).length, 1, "approve-reading asked for the pre-fill");
    await storeIdeas(reviewId, factId, [idea(0, "a", { pickable: false }), idea(1, "a"), idea(2, "a")], NOTE);
    assert.equal((await prefill(reviewId, factId)).ok, true);
    const gags = await gagsOf(factId);
    assert.equal(gags.length, 1);
    assert.equal(gags[0]!.slot, 1);
    assert.equal(sceneOf(gags[0]!), "{NAME} does thing 1 (a).", "an idea that can't be used is skipped");
    assert.ok((gags[0]!.pendingContent as { castExtraction?: unknown }).castExtraction, "its cast was read");
    assert.deepEqual(gags[0]!.prefilledFrom, { scene: "{NAME} does thing 1 (a).", bubbles: [], humorNote: NOTE });
    assert.equal(gags[0]!.createdBy, adminId);

    // Run again: the fact has a gag now, so nothing changes.
    assert.equal((await prefill(reviewId, factId)).ok, true);
    assert.equal((await gagsOf(factId)).length, 1);
  });

  it("the gags view says a fill is under way while the ideas call for one, and not once it has landed", async () => {
    const { reviewId, factId } = await atGags();
    assert.equal((await buildFactGagsView(factId))!.filling, false, "no ideas yet");
    await storeIdeas(reviewId, factId, [idea(0, "v")], NOTE);
    assert.equal((await buildFactGagsView(factId))!.filling, true);
    await prefill(reviewId, factId);
    assert.equal((await buildFactGagsView(factId))!.filling, false);
  });

  it("a gag the moderator saved first is never replaced", async () => {
    const { reviewId, factId } = await atGags();
    await db.insert(factGagsTable).values({ factId, slot: 1, pendingContent: { coreSceneOverride: "{NAME} wrote this by hand.", bubbles: [] }, createdBy: adminId });
    await storeIdeas(reviewId, factId, [idea(0, "b")], NOTE);
    await prefill(reviewId, factId);
    const gags = await gagsOf(factId);
    assert.equal(gags.length, 1);
    assert.equal(sceneOf(gags[0]!), "{NAME} wrote this by hand.");
    assert.equal(gags[0]!.prefilledFrom, null);
  });

  it("nothing is filled off the Gags step", async () => {
    const { reviewId, factId } = await atGags();
    await db.update(pendingReviewsTable).set({ workflowStage: "test_renders" }).where(eq(pendingReviewsTable.id, reviewId));
    await storeIdeas(reviewId, factId, [idea(0, "c")], NOTE);
    await prefill(reviewId, factId);
    assert.equal((await gagsOf(factId)).length, 0);
  });

  it("ideas written under another note than the saved one are not used", async () => {
    const { reviewId, factId } = await atGags();
    await storeIdeas(reviewId, factId, [idea(0, "d")], "An older reading.");
    await prefill(reviewId, factId);
    assert.equal((await gagsOf(factId)).length, 0);
  });

  it("a pre-filled gag still exactly its idea is left out of the gag writer's context", async () => {
    const { reviewId, factId } = await atGags();
    await storeIdeas(reviewId, factId, [idea(0, "e")], NOTE);
    await prefill(reviewId, factId);
    assert.deepEqual(await contextGagsFor(factId), [], "an untouched pre-filled gag is one of the ideas");
    const [gag] = await gagsOf(factId);
    const content = { ...(gag!.pendingContent as object), coreSceneOverride: "{NAME} does thing 0, edited." };
    await db.update(factGagsTable).set({ pendingContent: content }).where(eq(factGagsTable.id, gag!.id));
    assert.equal((await contextGagsFor(factId)).length, 1, "edited by hand, it is the moderator's");
  });
});

describe("a changed note", () => {
  it("saving a changed note writes fresh ideas by itself; saving the same note does not", async () => {
    const { reviewId } = await atGags();
    const before = (await ideaJobs(reviewId)).length;
    const same = await request(app).put(url(reviewId, "humor-note")).send({ text: NOTE });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.ideasRewritten, false);
    assert.equal((await ideaJobs(reviewId)).length, before);
    const changed = await request(app).put(url(reviewId, "humor-note")).send({ text: "A different reading of the joke." });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.ideasRewritten, true);
    assert.equal((await ideaJobs(reviewId)).length, before + 1);
  });

  it("replaces every gag still exactly its idea, drops its picks, and keeps a gag edited by hand", async () => {
    const { reviewId, factId } = await atGags();
    await storeIdeas(reviewId, factId, [idea(0, "f"), idea(1, "f"), idea(2, "f")], NOTE);
    await prefill(reviewId, factId);
    const [gag1] = await gagsOf(factId);
    // Gag 2 pre-filled too (as a used idea would be), then edited by hand.
    await db.insert(factGagsTable).values({ factId, slot: 2, pendingContent: { ...(gag1!.pendingContent as object), coreSceneOverride: "{NAME} does thing 1 (f), edited." }, prefilledFrom: { scene: "{NAME} does thing 1 (f).", bubbles: [], humorNote: NOTE } });
    // A draft pick on gag 1, made for its current content.
    const attemptId = await insertExampleRender(factId, gag1!.id, gag1!.pendingContent, "male");
    await db.insert(factGagExamplesTable).values({ gagId: gag1!.id, subjectKind: "male", stage: "pending", attemptId, approvedBy: adminId });

    const corrected = "A different reading of the joke.";
    await db.update(factsTable).set({ humorNote: corrected }).where(eq(factsTable.id, factId));
    await storeIdeas(reviewId, factId, [idea(0, "g"), idea(1, "g"), idea(2, "g")], corrected);
    await prefill(reviewId, factId);

    const gags = await gagsOf(factId);
    assert.equal(sceneOf(gags[0]!), "{NAME} does thing 0 (g).", "untouched gag 1 takes the new idea in its position");
    assert.deepEqual(gags[0]!.prefilledFrom, { scene: "{NAME} does thing 0 (g).", bubbles: [], humorNote: corrected });
    assert.equal(sceneOf(gags[1]!), "{NAME} does thing 1 (f), edited.", "a gag edited by hand is kept");
    const picks = await db.select().from(factGagExamplesTable).where(eq(factGagExamplesTable.gagId, gag1!.id));
    assert.equal(picks.length, 0, "the replaced gag's picks are dropped");
  });

  it("ideas written again under the same note replace nothing", async () => {
    const { reviewId, factId } = await atGags();
    await storeIdeas(reviewId, factId, [idea(0, "h")], NOTE);
    await prefill(reviewId, factId);
    await storeIdeas(reviewId, factId, [idea(0, "i")], NOTE);
    await prefill(reviewId, factId);
    assert.equal(sceneOf((await gagsOf(factId))[0]!), "{NAME} does thing 0 (h).");
  });

  it("a gag edited after the decision but before the write is kept", async () => {
    const { reviewId, factId } = await atGags();
    await storeIdeas(reviewId, factId, [idea(0, "j")], NOTE);
    await prefill(reviewId, factId);
    const corrected = "Yet another reading.";
    await db.update(factsTable).set({ humorNote: corrected }).where(eq(factsTable.id, factId));
    await storeIdeas(reviewId, factId, [idea(0, "k")], corrected);
    const [gag] = await gagsOf(factId);
    // The moderator saves an edit while the cast is being read.
    const racing: GagPrefillDeps = {
      readCast: async (f, body) => {
        const scene = "{NAME} does thing 0 (j), mine now.";
        const cast = await castStub.readCast(f, { scene, bubbles: [] });
        await saveGagContent(factId, gag!.id, { ...(gag!.pendingContent as object), coreSceneOverride: scene, cast: cast.cast, castExtraction: cast.castExtraction }, { adminId, reviewId });
        return castStub.readCast(f, body);
      },
    };
    assert.equal((await runGagPrefill({ reviewId, factId, adminId }, racing)).ok, true);
    assert.equal(sceneOf((await gagsOf(factId))[0]!), "{NAME} does thing 0 (j), mine now.");
  });
});

describe("a fill's status is its job's (Codex 4649903956 and 4649903966, PR #1136 round 1)", () => {
  const setJobs = (reviewId: number, status: "done" | "failed" | "pending") =>
    db.update(asyncJobsTable).set({ status, ...(status === "pending" ? { runAfter: new Date(Date.now() + 5 * 60_000) } : {}) })
      .where(like(asyncJobsTable.dedupeKey, `${GAG_PREFILL_QUEUE}:${reviewId}:%`));
  /** Gag 1 filled under NOTE, then the note changed and its new ideas stored: a replacement is called for. */
  async function replacementDue(): Promise<{ reviewId: number; factId: number }> {
    const { reviewId, factId } = await atGags();
    await storeIdeas(reviewId, factId, [idea(0, "r1")], NOTE);
    await prefill(reviewId, factId);
    await setJobs(reviewId, "done");
    const corrected = `A changed reading ${randomUUID().slice(0, 4)}.`;
    await db.update(factsTable).set({ humorNote: corrected }).where(eq(factsTable.id, factId));
    await storeIdeas(reviewId, factId, [idea(0, "r2")], corrected);
    return { reviewId, factId };
  }

  it("approving the Gags step waits while the fill's job is in flight, and goes through once it has run", async () => {
    const { reviewId, factId } = await replacementDue();
    await enqueueGagPrefill({ reviewId, factId });
    assert.equal((await buildFactGagsView(factId))!.filling, true);
    const refused = await request(app).post(url(reviewId, "approve-visual-concept")).send({});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "GAGS_FILLING");
    assert.equal((await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)))[0]!.workflowStage, "gags");

    await prefill(reviewId, factId);
    await setJobs(reviewId, "done");
    assert.equal((await buildFactGagsView(factId))!.filling, false);
    assert.equal(sceneOf((await gagsOf(factId))[0]!), "{NAME} does thing 0 (r2).");
    const approved = await request(app).post(url(reviewId, "approve-visual-concept")).send({});
    assert.notEqual(approved.body.code, "GAGS_FILLING", JSON.stringify(approved.body));
  });

  it("a fill waiting out a retry still reads as under way", async () => {
    const { reviewId, factId } = await replacementDue();
    await enqueueGagPrefill({ reviewId, factId });
    await setJobs(reviewId, "pending");
    assert.equal((await buildFactGagsView(factId))!.filling, true);
  });

  it("a fill that ended having skipped an idea it could not use is not under way, and approval is not held", async () => {
    const { reviewId, factId } = await replacementDue();
    await enqueueGagPrefill({ reviewId, factId });
    const unusable: GagPrefillDeps = { readCast: async (f, body) => ({ ...(await castStub.readCast(f, body)), cast: [], unboundSpeakers: ["mailman"] }) };
    // A speaker the scene does not show: the idea cannot be a gag.
    await storeIdeas(reviewId, factId, [{ ...idea(0, "r3"), bubbles: [{ type: "speech", entity: "mailman", text: "Hi.", tokenValid: true }] as never }], (await db.select().from(factsTable).where(eq(factsTable.id, factId)))[0]!.humorNote);
    assert.equal((await runGagPrefill({ reviewId, factId, adminId }, unusable)).ok, true);
    await setJobs(reviewId, "done");
    const view = (await buildFactGagsView(factId))!;
    assert.equal(view.filling, false);
    assert.equal(view.fillFailed, false);
    const r = await request(app).post(url(reviewId, "approve-visual-concept")).send({});
    assert.notEqual(r.body.code, "GAGS_FILLING");
  });

  it("a fill that failed for good says so, and holds nothing", async () => {
    const { reviewId, factId } = await replacementDue();
    await enqueueGagPrefill({ reviewId, factId });
    await setJobs(reviewId, "failed");
    const view = (await buildFactGagsView(factId))!;
    assert.equal(view.filling, false);
    assert.equal(view.fillFailed, true);
  });

  it("each gag says whether it is still exactly the idea it was filled from", async () => {
    const { reviewId, factId } = await atGags();
    await storeIdeas(reviewId, factId, [idea(0, "u")], NOTE);
    await prefill(reviewId, factId);
    assert.equal((await buildFactGagsView(factId))!.gags[0]!.prefilledUntouched, true);
    const [gag] = await gagsOf(factId);
    await db.update(factGagsTable).set({ pendingContent: { ...(gag!.pendingContent as object), coreSceneOverride: "{NAME} mine." } }).where(eq(factGagsTable.id, gag!.id));
    assert.equal((await buildFactGagsView(factId))!.gags[0]!.prefilledUntouched, false);
  });
});
