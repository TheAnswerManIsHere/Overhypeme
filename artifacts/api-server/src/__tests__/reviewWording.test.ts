/**
 * A fact's wording locks at triage (plan docs/plans/PLAN_THREE_GAGS.md,
 * increment 3, Testing Plan item 13; David 2026-11-14, Q5 and Q6):
 *
 *   - at triage an admin edit changes the wording, is validated, recomputes
 *     the duplicate match and is recorded with the wording as submitted;
 *   - after acceptance the edit is refused, and the database refuses any
 *     change to the fact's text;
 *   - a triage edit racing acceptance, in both completion orders, locks the
 *     edited wording or refuses the edit, never the stale wording;
 *   - Withdraw ends a submission past triage for good: it leaves the queue
 *     and the submitter's pending count, and its fact can never go live.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, factsTable, usersTable } from "@workspace/db";
import { activityFeedTable, asyncJobsTable, pendingReviewsTable } from "@workspace/db/schema";
import { UNRESOLVED_SUBMISSION_STAGE_VALUES } from "@workspace/api-zod";

import reviewsRouter from "../routes/reviews.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { findPendingReviewWithText } from "../routes/ai.js";
import { advanceReviewForStagingFactEnrichment } from "../lib/moderationStaging.js";

const RUN = randomUUID().slice(0, 8);
let adminId = "";
let submitterId = "";
let app: ReturnType<typeof buildTestApp>;
const reviewIds: number[] = [];
/**
 * One stub for the whole file, keyed by review: the describes run
 * concurrently, so a test never swaps the shared stub; it counts calls for its
 * own review, or holds its own review's check.
 */
const callsFor = new Map<number, number>();
const holdFor = new Map<number, Promise<void>>();

async function triageReview(text = `{NAME} submitted wording ${RUN} ${randomUUID().slice(0, 6)}.`): Promise<number> {
  const [row] = await db.insert(pendingReviewsTable).values({
    submittedText: text, submittedById: submitterId, status: "pending", workflowStage: "triage_pending",
  }).returning({ id: pendingReviewsTable.id });
  reviewIds.push(row!.id);
  return row!.id;
}
const reviewRow = async (id: number) => (await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)))[0]!;
const url = (id: number, rest: string) => `/api/admin/reviews/${id}/${rest}`;
const accept = (id: number) => request(app).post(url(id, "provisional-approve")).send({});

before(async () => {
  adminId = `t-wording-admin-${RUN}`;
  submitterId = `t-wording-user-${RUN}`;
  await db.insert(usersTable).values([
    { id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" },
    { id: submitterId, email: `${submitterId}@test.local`, isAdmin: false, membershipTier: "registered" },
  ]);
  app = buildTestApp({ kind: "authenticated", userId: adminId }, reviewsRouter);
  // The app's own detector: the runner shares one process between test files.
  app.locals["duplicateDetector"] = async (_text: string, opts: { excludeReviewId?: number }) => {
    const id = opts.excludeReviewId ?? -1;
    callsFor.set(id, (callsFor.get(id) ?? 0) + 1);
    await holdFor.get(id);
    return { outcome: "distinct" as const, confidence: 42 };
  };
});

after(async () => {
  const reviews = reviewIds.length ? await db.select({ stagingFactId: pendingReviewsTable.stagingFactId }).from(pendingReviewsTable).where(inArray(pendingReviewsTable.id, reviewIds)) : [];
  const factIds = reviews.map((r) => r.stagingFactId).filter((x): x is number => x != null);
  if (reviewIds.length) await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.id, reviewIds));
  if (factIds.length) {
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.externalId, factIds.map(String)));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  // Acceptance and Withdraw write the submitter's activity feed.
  await db.delete(activityFeedTable).where(inArray(activityFeedTable.userId, [adminId, submitterId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, submitterId]));
});

describe("the wording at triage", () => {
  it("an admin edit changes the wording, recomputes the duplicate match and records the wording as submitted", async () => {
    const id = await triageReview("{NAME} can count to infinity twice, the first time slowly.");
    const res = await request(app).post(url(id, "wording")).send({ text: "{NAME} counted to infinity. Twice." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(callsFor.get(id), 1, "the duplicate match is recomputed for the new wording, excluding this review");
    const row = await reviewRow(id);
    assert.equal(row.submittedText, "{NAME} counted to infinity. Twice.");
    assert.equal(row.submittedTextOriginal, "{NAME} can count to infinity twice, the first time slowly.");
    assert.equal(row.wordingEditedBy, adminId);
    assert.ok(row.wordingEditedAt);
    assert.equal(row.matchingSimilarity, 42);

    await request(app).post(url(id, "wording")).send({ text: "{NAME} counted to infinity, twice over." });
    assert.equal((await reviewRow(id)).submittedTextOriginal, "{NAME} can count to infinity twice, the first time slowly.", "the wording as submitted is kept from the first edit");
  });

  it("validates like a submission: too short or a bad token is refused and nothing changes", async () => {
    const id = await triageReview();
    const original = (await reviewRow(id)).submittedText;
    for (const text of ["short", "{NAME} meets {BOGUS_TOKEN} at the shop."]) {
      const res = await request(app).post(url(id, "wording")).send({ text });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(res.body.code, "WORDING_INVALID");
    }
    assert.equal((await reviewRow(id)).submittedText, original);
  });
});

describe("the duplicate check for an edited wording", () => {
  it("never matches the edited submission itself, and still matches another pending submission", async () => {
    const wording = `{NAME} matches itself ${RUN} ${randomUUID().slice(0, 6)}.`;
    const edited = await triageReview(wording);
    const normalized = wording.toUpperCase().trim().toLowerCase();
    assert.equal((await findPendingReviewWithText(normalized))?.id, edited, "without the exclusion the edited review is its own match");
    assert.equal(await findPendingReviewWithText(normalized, edited), null, "a case-only edit is not a duplicate of itself");
    const other = await triageReview(wording);
    assert.equal((await findPendingReviewWithText(normalized, edited))?.id, other, "another pending submission with the same wording still counts");
  });

  it("the route passes the edited review to the duplicate check", async () => {
    const id = await triageReview();
    await request(app).post(url(id, "wording")).send({ text: `{NAME} a different wording ${RUN}.` });
    assert.equal(callsFor.get(id), 1, "the check excludes the edited review");
  });
});

describe("the wording locks on acceptance", () => {
  it("after acceptance the edit is refused, the fact carries the edited wording, and the database refuses a change", async () => {
    const id = await triageReview();
    await request(app).post(url(id, "wording")).send({ text: `{NAME} wording edited at triage ${RUN}.` });
    const accepted = await accept(id);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const row = await reviewRow(id);
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, row.stagingFactId!));
    assert.equal(fact!.text, `{NAME} wording edited at triage ${RUN}.`);

    const refused = await request(app).post(url(id, "wording")).send({ text: "{NAME} a later edit to the wording." });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "WORDING_LOCKED");
    await assert.rejects(db.update(factsTable).set({ text: "{NAME} edited around the route." }).where(eq(factsTable.id, fact!.id)));
  });

  it("an edit racing acceptance either lands before it or is refused, never leaving the stale wording", async () => {
    // The edit's duplicate check is held while acceptance runs: the edit is then refused.
    const lateEdit = await triageReview();
    const original = (await reviewRow(lateEdit)).submittedText;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    holdFor.set(lateEdit, held);
    const editing = request(app).post(url(lateEdit, "wording")).send({ text: "{NAME} a racing edit that comes too late." }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await accept(lateEdit)).status, 200);
    release();
    const edited = await editing;
    assert.equal(edited.status, 409, JSON.stringify(edited.body));
    assert.equal(edited.body.code, "WORDING_LOCKED");
    const row = await reviewRow(lateEdit);
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, row.stagingFactId!));
    assert.equal(fact!.text, original, "the fact holds the wording acceptance read");
    assert.equal(row.submittedText, original);

    // The other order: the edit completes first, and acceptance locks the edited wording.
    const earlyEdit = await triageReview();
    assert.equal((await request(app).post(url(earlyEdit, "wording")).send({ text: `{NAME} an edit that lands first ${RUN}.` })).status, 200);
    assert.equal((await accept(earlyEdit)).status, 200);
    const early = await reviewRow(earlyEdit);
    const [earlyFact] = await db.select().from(factsTable).where(eq(factsTable.id, early.stagingFactId!));
    assert.equal(earlyFact!.text, `{NAME} an edit that lands first ${RUN}.`);
  });
});

describe("Withdraw: wording needs replacing", () => {
  it("ends the submission for good: off the queue and the pending count, never live", async () => {
    const id = await triageReview();
    assert.equal((await accept(id)).status, 200);
    const unresolved = async () => (await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.submittedById, submitterId)))
      .filter((r) => (UNRESOLVED_SUBMISSION_STAGE_VALUES as readonly string[]).includes(r.workflowStage)).length;
    const pendingBefore = await unresolved();

    const res = await request(app).post(url(id, "withdraw")).send({ note: "The joke reads backwards." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await reviewRow(id);
    assert.equal(row.status, "rejected");
    assert.equal(row.workflowStage, "production_rejected");
    assert.ok(row.withdrawnAt);
    assert.equal(row.withdrawnBy, adminId);
    assert.equal(await unresolved(), pendingBefore - 1, "the submitter's pending count drops");

    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, row.stagingFactId!));
    assert.ok(fact!.wordingWithdrawnAt);
    assert.equal(fact!.isActive, false);
    await assert.rejects(db.update(factsTable).set({ isActive: true }).where(eq(factsTable.id, fact!.id)), "the database keeps it inactive");

    const again = await request(app).post(url(id, "withdraw")).send({});
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "NOT_WITHDRAWABLE");
    assert.equal((await request(app).post(url(id, "approve-for-production")).send({})).status >= 400, true, "a resolved review cannot be approved");
  });

  it("stays final when prep finishes after it: the late result moves nothing", async () => {
    const id = await triageReview();
    assert.equal((await accept(id)).status, 200);
    assert.equal((await request(app).post(url(id, "withdraw")).send({})).status, 200);
    const factId = (await reviewRow(id)).stagingFactId!;
    // A withdrawn review is resolved, so the late result finds nothing to advance.
    await advanceReviewForStagingFactEnrichment({ factId, outcome: "success" });
    await advanceReviewForStagingFactEnrichment({ factId, outcome: "terminal_failed" });
    const row = await reviewRow(id);
    assert.equal(row.workflowStage, "production_rejected");
    assert.equal(row.status, "rejected");
  });

  it("a stale acceptance re-check refuses a review withdrawn since its first read", async () => {
    // Acceptance from prep_failed (a retry) reads the review, then locks it. A
    // withdrawal landing between the two leaves the locked row resolved, and
    // acceptance answers 409 rather than writing prep_pending over it.
    const id = await triageReview();
    assert.equal((await accept(id)).status, 200);
    await db.update(pendingReviewsTable).set({ workflowStage: "prep_failed" }).where(eq(pendingReviewsTable.id, id));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let lockHolder!: Promise<unknown>;
    const lockTaken = new Promise<void>((taken) => {
      lockHolder = db.transaction(async (tx) => {
        await tx.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)).for("update");
        taken();
        await held;
        await tx.update(pendingReviewsTable).set({ status: "rejected", workflowStage: "production_rejected", withdrawnAt: new Date(), withdrawnBy: adminId }).where(eq(pendingReviewsTable.id, id));
      });
    });
    await lockTaken;
    const retry = accept(id).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    release();
    await lockHolder;
    const res = await retry;
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const row = await reviewRow(id);
    assert.equal(row.workflowStage, "production_rejected");
    assert.equal(row.status, "rejected");
  });

  it("is refused at triage, where the wording can still be edited", async () => {
    const id = await triageReview();
    const res = await request(app).post(url(id, "withdraw")).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "NOT_WITHDRAWABLE");
    assert.equal((await reviewRow(id)).status, "pending");
  });
});
