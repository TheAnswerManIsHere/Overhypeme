/**
 * The Reading step (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1B; Issue #1018,
 * increment 1.2c-ii):
 *   - acceptance starts a reading run; the run stores research and a draft
 *     note, and starts gag ideas from the draft while the review waits at
 *     Reading and the run is the latest;
 *   - a run that gives up fails visibly; "Try again" starts another, refused
 *     while one is in flight and anywhere but Reading;
 *   - "Approve" records the note with the run it was written from, moves the
 *     review to Gags, records the admin action, and rewrites the ideas when
 *     the approved note differs from the one they were written from;
 *   - ideas written from a note replaced while they ran are not stored: the
 *     job runs again from the note as it is now.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, factsTable, usersTable } from "@workspace/db";
import { activityFeedTable, adminActionsTable, asyncJobsTable, factReadingsTable, pendingReviewsTable } from "@workspace/db/schema";
import type { FactReadingResult } from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { latestReading, readingJobHandler, runReadingJob } from "../lib/readingJobs.js";
import { runVisualConceptsJob } from "../lib/visualConceptJobs.js";
import type { generateVisualConcepts } from "../lib/visualConcepts/generator.js";

const RUN = randomUUID().slice(0, 8);
let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const reviewIds: number[] = [];

const RESULT: FactReadingResult = {
  references: [{
    phrase: "Shark Week",
    meaning: "A TV week of shark documentaries; here the sharks watch Alex.",
    pictureImplication: "Sharks watching Alex on TV, NOT Alex watching sharks.",
    sources: [{ title: "Shark Week", url: "https://example.com/shark-week" }],
  }],
  humorNote: "Normally people watch sharks; here the sharks hold a week for Alex.",
};
const read = (result: FactReadingResult = RESULT) => async () => ({ result, provenance: { model: "stub" } });

const url = (id: number, rest: string) => `/api/admin/reviews/${id}/${rest}`;
const reviewRow = async (id: number) => (await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)))[0]!;
const factRow = async (id: number) => (await db.select().from(factsTable).where(eq(factsTable.id, id)))[0]!;
/** The review's ideas jobs, each its own generation (`fact_visual_concepts:review:<id>:<generation>`), oldest first. */
const ideaJobs = (reviewId: number, status?: "pending" | "processing" | "done") => db
  .select({ id: asyncJobsTable.id, status: asyncJobsTable.status, payload: asyncJobsTable.payload }).from(asyncJobsTable)
  .where(and(
    eq(asyncJobsTable.queue, "fact_visual_concepts"),
    like(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${reviewId}:%`),
    ...(status ? [eq(asyncJobsTable.status, status)] : []),
  ))
  .orderBy(asyncJobsTable.id);
/** Run a queued ideas job as the worker would: from its own payload, which carries its generation. */
const runIdeasJob = (job: { payload: unknown }, generate = stubIdeas) =>
  runVisualConceptsJob(job.payload as Parameters<typeof runVisualConceptsJob>[0], { generate });

/** A submission accepted through the route: at Reading, with its first run pending. */
async function accepted(): Promise<{ reviewId: number; factId: number; readingId: number }> {
  const [row] = await db.insert(pendingReviewsTable).values({
    submittedText: `{NAME} has a Shark Week of their own ${RUN} ${randomUUID().slice(0, 6)}.`, submittedById: adminId, status: "pending", workflowStage: "triage",
  }).returning({ id: pendingReviewsTable.id });
  reviewIds.push(row!.id);
  const res = await request(app).post(url(row!.id, "provisional-approve")).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const factId: number = res.body.stagingFactId;
  const run = await latestReading(factId);
  return { reviewId: row!.id, factId, readingId: run!.id };
}

before(async () => {
  adminId = `t-reading-admin-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  app = buildTestApp({ kind: "authenticated", userId: adminId }, reviewsRouter);
  app.locals["duplicateDetector"] = async () => ({ outcome: "distinct" as const, confidence: 0 });
});

after(async () => {
  const reviews = reviewIds.length ? await db.select({ stagingFactId: pendingReviewsTable.stagingFactId }).from(pendingReviewsTable).where(inArray(pendingReviewsTable.id, reviewIds)) : [];
  const factIds = reviews.map((r) => r.stagingFactId).filter((x): x is number => x != null);
  for (const id of reviewIds) await db.delete(asyncJobsTable).where(like(asyncJobsTable.dedupeKey, `fact_visual_concepts:review:${id}:%`));
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

describe("the reading run", () => {
  it("stores the research and the draft note, and starts gag ideas from the draft while the review waits at Reading", async () => {
    const { reviewId, factId, readingId } = await accepted();
    assert.equal((await ideaJobs(reviewId)).length, 0, "no ideas before the reading");
    const res = await runReadingJob({ readingId }, { read: read() });
    assert.equal(res.ok, true);
    const run = (await latestReading(factId))!;
    assert.equal(run.status, "ok");
    assert.equal(run.draftNote, RESULT.humorNote);
    assert.deepEqual((run.research as { references: unknown[] }).references, RESULT.references);
    assert.ok(run.completedAt);
    assert.equal((await reviewRow(reviewId)).workflowStage, "reading", "the reading never moves the review");
    assert.equal((await ideaJobs(reviewId)).length, 1, "ideas are queued from the draft");
    assert.equal((await factRow(factId)).visualConceptStatus, "pending");

    const detail = await request(app).get(`/api/admin/reviews/${reviewId}`);
    assert.equal(detail.body.reading.latest.status, "ok");
    assert.equal(detail.body.reading.latest.draftNote, RESULT.humorNote);
    assert.equal(detail.body.reading.approved, null);
  });

  it("finding no references is a result, not a failure", async () => {
    const { factId, readingId } = await accepted();
    await runReadingJob({ readingId }, { read: read({ references: [], humorNote: "Alex simply is that strong." }) });
    const run = (await latestReading(factId))!;
    assert.equal(run.status, "ok");
    assert.deepEqual(run.research, { references: [] });
  });

  it("a model fault is retryable; giving up fails the run visibly and moves nothing", async () => {
    const { reviewId, factId, readingId } = await accepted();
    const res = await runReadingJob({ readingId }, { read: async () => { throw new Error("timeout"); } });
    assert.equal(res.ok, false);
    assert.equal((await latestReading(factId))!.status, "pending", "still pending while the queue retries");
    await readingJobHandler.onAbandon!({ payload: { readingId }, lastError: "timeout" } as never);
    const run = (await latestReading(factId))!;
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /timeout/);
    assert.equal((await reviewRow(reviewId)).workflowStage, "reading");
    assert.equal((await ideaJobs(reviewId)).length, 0);
  });

  it("a stale run (a newer one exists) stores its result but starts no ideas", async () => {
    const { reviewId, factId, readingId } = await accepted();
    await readingJobHandler.onAbandon!({ payload: { readingId }, lastError: "x" } as never);
    const retry = await request(app).post(url(reviewId, "reading/retry")).send({});
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    // The first run's late answer arrives after the retry began (its row is reopened for the test).
    await db.update(factReadingsTable).set({ status: "pending" }).where(eq(factReadingsTable.id, readingId));
    await runReadingJob({ readingId }, { read: read() });
    assert.equal((await ideaJobs(reviewId)).length, 0, "only the latest run starts ideas");
    assert.equal((await latestReading(factId))!.id, retry.body.readingId);
  });
});

describe("Try again", () => {
  it("is refused while a run is in flight, starts a new run after a failure, and is recorded", async () => {
    const { reviewId, factId, readingId } = await accepted();
    const busy = await request(app).post(url(reviewId, "reading/retry")).send({});
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, "READING_PENDING");
    await readingJobHandler.onAbandon!({ payload: { readingId }, lastError: "x" } as never);
    const res = await request(app).post(url(reviewId, "reading/retry")).send({});
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const run = (await latestReading(factId))!;
    assert.equal(run.id, res.body.readingId);
    assert.equal(run.status, "pending");
    const actions = await db.select({ action: adminActionsTable.action, detail: adminActionsTable.detail, factId: adminActionsTable.factId })
      .from(adminActionsTable).where(and(eq(adminActionsTable.reviewId, reviewId), eq(adminActionsTable.action, "reading_requested")));
    assert.deepEqual(actions, [{ action: "reading_requested", factId, detail: { readingId: run.id, after: "failed" } }]);
  });

  it("is refused anywhere but Reading (REVIEW_MOVED)", async () => {
    const { reviewId } = await accepted();
    await db.update(pendingReviewsTable).set({ workflowStage: "gags" }).where(eq(pendingReviewsTable.id, reviewId));
    const res = await request(app).post(url(reviewId, "reading/retry")).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "REVIEW_MOVED");
  });
});

describe("Approve the humor note", () => {
  it("records the note with its run, moves to Gags, records the action, and keeps ideas written from the same note", async () => {
    const { reviewId, factId, readingId } = await accepted();
    await runReadingJob({ readingId }, { read: read() });
    // The ideas from the draft land.
    const [job] = await ideaJobs(reviewId);
    await runIdeasJob(job!);
    await db.update(asyncJobsTable).set({ status: "done" }).where(eq(asyncJobsTable.id, job!.id));

    const res = await request(app).post(url(reviewId, "approve-reading")).send({ text: RESULT.humorNote, readingId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.workflowStage, "gags");
    assert.equal(res.body.ideasRewritten, false, "ideas written from this note are kept");
    const f = await factRow(factId);
    assert.equal(f.humorNote, RESULT.humorNote);
    assert.equal(f.humorNoteApprovedBy, adminId);
    assert.equal(f.humorNoteReadingId, readingId);
    assert.equal((await reviewRow(reviewId)).workflowStage, "gags");
    const actions = await db.select({ detail: adminActionsTable.detail }).from(adminActionsTable)
      .where(and(eq(adminActionsTable.reviewId, reviewId), eq(adminActionsTable.action, "reading_approval")));
    assert.deepEqual(actions.map((a) => a.detail), [{ readingId, text: RESULT.humorNote, edited: false }]);
    assert.equal((await ideaJobs(reviewId, "pending")).length, 0, "no rewrite");

    const detail = await request(app).get(`/api/admin/reviews/${reviewId}`);
    assert.equal(detail.body.reading.approved.text, RESULT.humorNote);
    assert.equal(detail.body.reading.approved.readingId, readingId);
  });

  it("rewrites the ideas when the approved note differs from the draft they were written from", async () => {
    const { reviewId, factId, readingId } = await accepted();
    await runReadingJob({ readingId }, { read: read() });
    const [job] = await ideaJobs(reviewId);
    await runIdeasJob(job!);
    await db.update(asyncJobsTable).set({ status: "done" }).where(eq(asyncJobsTable.id, job!.id));

    const corrected = "The sharks are the audience; Alex is the show.";
    const res = await request(app).post(url(reviewId, "approve-reading")).send({ text: corrected, readingId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ideasRewritten, true);
    assert.equal((await ideaJobs(reviewId, "pending")).length, 1, "ideas are written again from the approved note");
    assert.equal((await factRow(factId)).visualConceptStatus, "pending");
  });

  // Codex, PR #1041 round 1: an earlier ideas job that has stored its ideas
  // but is not yet marked done must not absorb the request for new ones.
  for (const earlier of ["ok", "failed"] as const) {
    it(`a rewrite asked for while the earlier job has stored "${earlier}" but is not yet done still runs, from the approved note`, async () => {
      const { reviewId, factId, readingId } = await accepted();
      await runReadingJob({ readingId }, { read: read() });
      const [first] = await ideaJobs(reviewId);
      if (earlier === "ok") await runIdeasJob(first!);
      else await db.update(factsTable).set({ visualConceptStatus: "failed" }).where(eq(factsTable.id, factId));
      await db.update(asyncJobsTable).set({ status: "processing" }).where(eq(asyncJobsTable.id, first!.id));

      const corrected = "The sharks are the audience; Alex is the show.";
      const res = await request(app).post(url(reviewId, "approve-reading")).send({ text: corrected, readingId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ideasRewritten, true);
      // The earlier job is finalized only now, as the worker would.
      await db.update(asyncJobsTable).set({ status: "done" }).where(eq(asyncJobsTable.id, first!.id));

      const queued = await ideaJobs(reviewId, "pending");
      assert.equal(queued.length, 1, "a runnable job remains for the new note");
      assert.notEqual(queued[0]!.id, first!.id);
      let sawNote: string | null = null;
      const ran = await runIdeasJob(queued[0]!, async (input) => { sawNote = input.humorNote; return stubIdeas(input); });
      assert.equal(ran.ok, true);
      assert.equal(sawNote, corrected);
      const f = await factRow(factId);
      assert.equal(f.visualConceptStatus, "ok");
      assert.equal((f.visualConceptCandidates as { humorNoteUsed?: string }).humorNoteUsed, corrected);
    });
  }

  it("an earlier generation that a later one replaced pays for nothing and writes nothing", async () => {
    const { reviewId, factId, readingId } = await accepted();
    await runReadingJob({ readingId }, { read: read() });
    const [first] = await ideaJobs(reviewId);
    await runIdeasJob(first!);
    await request(app).post(url(reviewId, "approve-reading")).send({ text: "A different joke.", readingId });
    const [second] = await ideaJobs(reviewId, "pending");
    // The first job is retried (say its finalize failed) after the second was queued.
    let called = false;
    const ran = await runIdeasJob(first!, async (input) => { called = true; return stubIdeas(input); });
    assert.equal(ran.ok, true);
    assert.equal(called, false, "no paid call for a superseded generation");
    assert.equal((await factRow(factId)).visualConceptStatus, "pending", "still the later generation's to finish");
    assert.ok(second);
  });

  it("ideas written from a note replaced while they ran are not stored: the job runs again", async () => {
    const { reviewId, factId, readingId } = await accepted();
    await runReadingJob({ readingId }, { read: read() });
    let sawNote: string | null = null;
    const corrected = "Alex is the documentary.";
    const [job] = await ideaJobs(reviewId);
    const res = await runVisualConceptsJob(job!.payload as Parameters<typeof runVisualConceptsJob>[0], {
      generate: async (input) => {
        sawNote = input.humorNote;
        // The moderator approves an edited note while the ideas are being written.
        await db.update(factsTable).set({ humorNote: corrected }).where(eq(factsTable.id, factId));
        return stubIdeas(input);
      },
    });
    assert.equal(sawNote, RESULT.humorNote, "written from the draft");
    assert.equal(res.ok, false, "retried");
    assert.equal((await factRow(factId)).visualConceptCandidates, null, "nothing stored for the old note");
  });

  it("refuses an empty note, a run that is not the latest, and no finished run", async () => {
    const { reviewId, readingId } = await accepted();
    assert.equal((await request(app).post(url(reviewId, "approve-reading")).send({ text: "  ", readingId })).status, 400);
    const notReady = await request(app).post(url(reviewId, "approve-reading")).send({ text: "A note.", readingId });
    assert.equal(notReady.status, 409);
    assert.equal(notReady.body.code, "READING_NOT_READY");
    await runReadingJob({ readingId }, { read: read() });
    const stale = await request(app).post(url(reviewId, "approve-reading")).send({ text: "A note.", readingId: readingId + 100000 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "READING_REPLACED");
    assert.equal((await reviewRow(reviewId)).workflowStage, "reading");
  });

  it("is refused anywhere but Reading (REVIEW_MOVED), and the Gags-step note edit is refused at Reading", async () => {
    const { reviewId, readingId } = await accepted();
    await runReadingJob({ readingId }, { read: read() });
    const edit = await request(app).put(url(reviewId, "humor-note")).send({ text: "Too early." });
    assert.equal(edit.status, 409);
    assert.equal(edit.body.code, "REVIEW_MOVED");
    await request(app).post(url(reviewId, "approve-reading")).send({ text: RESULT.humorNote, readingId });
    const again = await request(app).post(url(reviewId, "approve-reading")).send({ text: RESULT.humorNote, readingId });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "REVIEW_MOVED");
    assert.equal((await request(app).put(url(reviewId, "humor-note")).send({ text: "Corrected on Gags." })).status, 200);
  });
});

describe("Regenerate on the Gags step (Codex and Fable, PR #1041 round 1)", () => {
  /** A review at Gags whose first ideas job stored "ok" but is not yet marked done. */
  async function atGagsWithUnfinalizedJob() {
    const { reviewId, factId, readingId } = await accepted();
    await runReadingJob({ readingId }, { read: read() });
    const [first] = await ideaJobs(reviewId);
    await runIdeasJob(first!);
    await db.update(asyncJobsTable).set({ status: "processing" }).where(eq(asyncJobsTable.id, first!.id));
    const ok = await request(app).post(url(reviewId, "approve-reading")).send({ text: RESULT.humorNote, readingId });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ideasRewritten, false);
    return { reviewId, factId, first: first! };
  }

  it("a regenerate while the earlier job is not yet done still gets a job that runs", async () => {
    const { reviewId, factId, first } = await atGagsWithUnfinalizedJob();
    const res = await request(app).post(url(reviewId, "visual-concepts/regenerate")).send({});
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await db.update(asyncJobsTable).set({ status: "done" }).where(eq(asyncJobsTable.id, first.id));
    const queued = await ideaJobs(reviewId, "pending");
    assert.equal(queued.length, 1);
    assert.equal((await runIdeasJob(queued[0]!)).ok, true);
    assert.equal((await factRow(factId)).visualConceptStatus, "ok");
  });

  it("two regenerate requests start one generation", async () => {
    const { reviewId } = await atGagsWithUnfinalizedJob();
    const [a, b] = await Promise.all([
      request(app).post(url(reviewId, "visual-concepts/regenerate")).send({}),
      request(app).post(url(reviewId, "visual-concepts/regenerate")).send({}),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [202, 409]);
    assert.equal([a, b].find((r) => r.status === 409)!.body.code, "IDEAS_PENDING");
    assert.equal((await ideaJobs(reviewId, "pending")).length, 1);
  });
});

const stubIdeas: typeof generateVisualConcepts = async () => ({
  candidates: [0, 1, 2].map((i) => ({ title: `Idea ${i}`, whyItWorks: "Because.", sceneDescription: `{NAME} does thing ${i}.`, bubbles: [] })),
  provenance: { engineId: "stub", model: "stub", reasoningEffort: null, timeoutMs: 1, promptVersion: "stub", fallbackReason: null },
}) as never;
