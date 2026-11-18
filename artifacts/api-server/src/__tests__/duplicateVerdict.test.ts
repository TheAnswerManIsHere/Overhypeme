/**
 * The duplicate verdict (plan docs/plans/PLAN_DUPLICATE_VERDICT.md, Issue #1003):
 *
 *   - the detector's three outcomes: a validated AI answer decides, never the
 *     similarity number (a positive at ~0.77, a negative at ~0.9); a failure or
 *     a malformed answer is "unavailable", never "distinct"; no candidate at or
 *     above 0.65 is "distinct" without an AI call;
 *   - the exact pre-check ignores case, whitespace and punctuation, keeps
 *     template tokens, and finds another pending review by id;
 *   - a review's result is written only for the wording it checked, only at
 *     triage, and a throw is recorded as "unavailable";
 *   - a stored "duplicate" whose target no longer supports it reads
 *     "not_checked";
 *   - the routes: a submission ignores browser-sent match fields and the server
 *     checks the saved wording after commit; the on-demand check is admin-only
 *     and spends only when there is no usable verdict; a wording edit replaces
 *     the verdict with the wording.
 *
 * The embedding and AI stages are passed to each call (the runner shares one
 * process between test files, so no global stub is used). Each case embeds in
 * its own pair of dimensions, so the facts of one case are orthogonal to every
 * other case's query and cannot crowd its top five.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { eq, like, sql } from "drizzle-orm";
import { db, factsTable, usersTable } from "@workspace/db";
import { activityFeedTable, pendingReviewsTable } from "@workspace/db/schema";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { buildPlaceholderGag } from "@workspace/api-zod";

import { EMBEDDING_DIMENSIONS } from "../lib/embeddings.js";
import { checkDuplicateInternal, parseDuplicateAnswer, MalformedDuplicateAnswerError, type DuplicateCheckOptions } from "../routes/ai.js";
import { checkReviewDuplicate, duplicateView, type DuplicateDetector } from "../lib/duplicateVerdict.js";
import { duplicateMatchText } from "../lib/duplicateText.js";
import reviewsRouter, { __settleSubmitDuplicateChecksForTest } from "../routes/reviews.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const RUN = randomUUID().slice(0, 8);
const USER_PREFIX = `t_dupv_${RUN}_`;
let adminId = "";
let userId = "";

// ── seams ────────────────────────────────────────────────────────────────────

/**
 * A per-case marker word → the vector of any embedded text containing it. The
 * detector embeds the canonical render ({NAME} replaced), so the marker, not
 * the whole text, is the key.
 */
const vectors = new Map<string, number[]>();
let embedCalls = 0;
let embedThrows = false;
function unit(dim: number): number[] { const v = new Array(EMBEDDING_DIMENSIONS).fill(0); v[dim] = 1; return v; }
/** A unit vector at cosine `cos` from unit(a), in the (a, b) plane. */
function at(a: number, b: number, cos: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0); v[a] = cos; v[b] = Math.sqrt(1 - cos * cos); return v;
}
let llmCalls = 0;
let llmReply: string | Error = "{}";

/** The embedding and AI stages, passed per call. The AI stage runs the real answer validator. */
const stages: Pick<DuplicateCheckOptions, "embed" | "judge"> = {
  embed: async (input) => {
    embedCalls++;
    if (embedThrows) throw new Error("embedding service down");
    const v = [...vectors].find(([marker]) => input.includes(marker))?.[1];
    if (!v) throw new Error(`no test vector for ${JSON.stringify(input)}`);
    return v;
  },
  judge: async (_text, candidates) => {
    llmCalls++;
    if (llmReply instanceof Error) throw llmReply;
    return parseDuplicateAnswer(llmReply, candidates.length);
  },
};
const check = (text: string, opts: DuplicateCheckOptions = {}) => checkDuplicateInternal(text, { ...stages, ...opts });

// ── fixtures ─────────────────────────────────────────────────────────────────

const factIds: number[] = [];
async function fact(text: string, embedding?: number[], isActive = true): Promise<number> {
  const { id } = await insertLiveFact({ text, submittedById: adminId }, buildPlaceholderGag());
  if (embedding) await db.execute(sql`UPDATE facts SET embedding = ${`[${embedding.join(",")}]`}::vector WHERE id = ${id}`);
  if (!isActive) await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, id));
  factIds.push(id);
  return id;
}
async function review(text: string, extra: Partial<typeof pendingReviewsTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(pendingReviewsTable).values({
    submittedText: text, submittedById: userId, status: "pending", workflowStage: "triage", ...extra,
  }).returning({ id: pendingReviewsTable.id });
  return row!.id;
}
const reviewRow = async (id: number) => (await db.select().from(pendingReviewsTable).where(eq(pendingReviewsTable.id, id)))[0]!;

before(async () => {
  adminId = `${USER_PREFIX}admin`;
  userId = `${USER_PREFIX}user`;
  await db.insert(usersTable).values([
    { id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" },
    { id: userId, email: `${userId}@test.local`, isAdmin: false, membershipTier: "registered", emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() },
  ]);
});

after(async () => {
  await db.delete(pendingReviewsTable).where(like(pendingReviewsTable.submittedById, `${USER_PREFIX}%`));
  await db.delete(activityFeedTable).where(like(activityFeedTable.userId, `${USER_PREFIX}%`));
  if (factIds.length) await db.execute(sql`DELETE FROM facts WHERE id IN (${sql.join(factIds.map((id) => sql`${id}`), sql`, `)})`);
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
});

beforeEach(() => { embedCalls = 0; llmCalls = 0; embedThrows = false; llmReply = "{}"; });

// ── the AI answer ────────────────────────────────────────────────────────────

describe("the AI answer is validated before it can decide", () => {
  it("accepts a boolean verdict and, on a positive, an index naming a candidate", () => {
    assert.deepEqual(parseDuplicateAnswer('{"isDuplicate":false,"matchIndex":null}', 2), { isDuplicate: false, matchIndex: null });
    assert.deepEqual(parseDuplicateAnswer('{"isDuplicate":true,"matchIndex":2}', 2), { isDuplicate: true, matchIndex: 2 });
  });
  it("refuses a missing or non-boolean verdict, and a positive without a valid index", () => {
    for (const bad of ["{}", "not json", "[]", '{"isDuplicate":"yes"}', '{"isDuplicate":true}', '{"isDuplicate":true,"matchIndex":0}',
      '{"isDuplicate":true,"matchIndex":3}', '{"isDuplicate":true,"matchIndex":1.5}', '{"isDuplicate":true,"matchIndex":"1"}']) {
      assert.throws(() => parseDuplicateAnswer(bad, 2), MalformedDuplicateAnswerError, bad);
    }
  });
});

// ── the detector ─────────────────────────────────────────────────────────────

describe("the detector's verdict", () => {
  it("a positive AI answer at ~77% similarity is a duplicate of that fact (similarity does not decide)", async () => {
    const q = `{NAME} can hear sign languages ${RUN}`;
    const target = await fact(`{NAME} can hear sign language ${RUN}.`, at(300, 301, 0.77));
    vectors.set("languages", unit(300));
    llmReply = '{"isDuplicate":true,"matchIndex":1}';
    const r = await check(q);
    assert.equal(r.outcome, "duplicate");
    assert.equal(r.matchingFactId, target);
    assert.equal(llmCalls, 1);
  });

  it("a negative AI answer at ~90% similarity is distinct, keeping the nearest fact", async () => {
    const q = `{NAME} out-ran a cheetah backwards ${RUN}`;
    const near = await fact(`{NAME} out-ran a cheetah on a treadmill ${RUN}`, at(302, 303, 0.9));
    vectors.set("backwards", unit(302));
    llmReply = '{"isDuplicate":false,"matchIndex":null}';
    const r = await check(q);
    assert.equal(r.outcome, "distinct");
    assert.equal(r.matchingFactId, near);
    assert.equal(r.confidence, 90);
  });

  it("a malformed answer or a failed AI call is unavailable, keeping the nearest fact", async () => {
    const q = `{NAME} taught gravity to fall ${RUN}`;
    const near = await fact(`{NAME} taught gravity a lesson ${RUN}`, at(304, 305, 0.8));
    vectors.set("gravity to fall", unit(304));
    for (const reply of ["{}", '{"isDuplicate":true}', new Error("model down")]) {
      llmReply = reply;
      const r = await check(q);
      assert.equal(r.outcome, "unavailable", String(reply));
      assert.equal(r.isDuplicate, false);
      assert.equal(r.matchingFactId, near);
    }
  });

  it("a failed search is unavailable with no nearest fact", async () => {
    embedThrows = true;
    const r = await check(`{NAME} unplugged the internet ${RUN}`);
    assert.equal(r.outcome, "unavailable");
    assert.equal(r.matchingFactId, undefined);
    assert.equal(llmCalls, 0);
  });

  it("no candidate at or above 0.65 is distinct without an AI call", async () => {
    const q = `{NAME} counted the stars twice ${RUN}`;
    const far = await fact(`{NAME} painted the ocean blue ${RUN}`, at(306, 307, 0.5));
    vectors.set("stars twice", unit(306));
    const r = await check(q);
    assert.equal(r.outcome, "distinct");
    assert.equal(r.matchingFactId, far);
    assert.equal(llmCalls, 0);
  });

  it("an exact match ignores case, whitespace and punctuation, with no embedding or AI call", async () => {
    const id = await fact(`{NAME} can hear sign-language, clearly! ${RUN}.`);
    const r = await check(`{name}   can hear signlanguage clearly ${RUN}`);
    assert.equal(r.outcome, "duplicate");
    assert.equal(r.matchingFactId, id);
    assert.equal(embedCalls + llmCalls, 0);
  });

  it("the exact form keeps template tokens: a token-different template is not an exact match", async () => {
    const same = async (a: string, b: string) => (await db.execute(sql`SELECT ${duplicateMatchText(a)} = ${duplicateMatchText(b)} AS eq`)).rows[0]!.eq;
    assert.equal(await same("{NAME} {does|do} it.", "{name} {does|do} it"), true);
    assert.equal(await same("{NAME} {does|do} it", "{NAME} {SUBJ} it"), false);
    assert.equal(await same("{NAME} {does|do} it", "NAME doesdo it"), false);
  });

  it("an exact match with another pending review names it, and never matches the review itself", async () => {
    const text = `{NAME} juggles thunderstorms ${RUN}`;
    const other = await review(`${text}.`);
    const self = await review(text);
    const r = await check(text, { excludeReviewId: self });
    assert.equal(r.outcome, "duplicate");
    assert.equal(r.matchingReviewId, other);
    assert.equal(r.matchingFactId, undefined);
    const own = await check(`${text}.`, { excludeReviewId: other });
    assert.equal(own.matchingReviewId, self, "the other review still counts");
  });
});

// ── the per-review result ────────────────────────────────────────────────────

describe("a review's stored result", () => {
  const distinct: DuplicateDetector = async () => ({ outcome: "distinct", confidence: 40 });

  it("is written for the wording it checked", async () => {
    const id = await review(`{NAME} wrote result ${RUN} ${randomUUID().slice(0, 4)}`);
    const row = await checkReviewDuplicate(id, distinct);
    assert.equal(row?.duplicateOutcome, "distinct");
    assert.ok(row?.duplicateCheckedAt);
  });

  it("is not written when the wording changed while the check ran", async () => {
    const id = await review(`{NAME} old wording ${RUN} ${randomUUID().slice(0, 4)}`);
    await checkReviewDuplicate(id, async () => {
      await db.update(pendingReviewsTable).set({ submittedText: `{NAME} new wording ${RUN}` }).where(eq(pendingReviewsTable.id, id));
      return { outcome: "duplicate", confidence: 100, matchingFactId: undefined };
    });
    assert.equal((await reviewRow(id)).duplicateOutcome, null);
  });

  it("is not written when the review left triage while the check ran", async () => {
    const id = await review(`{NAME} left triage ${RUN} ${randomUUID().slice(0, 4)}`);
    await checkReviewDuplicate(id, async () => {
      await db.update(pendingReviewsTable).set({ status: "rejected", workflowStage: "rejected" }).where(eq(pendingReviewsTable.id, id));
      return { outcome: "distinct", confidence: 0 };
    });
    assert.equal((await reviewRow(id)).duplicateOutcome, null);
  });

  it("a detector that throws is recorded as unavailable, never distinct", async () => {
    const id = await review(`{NAME} throws ${RUN} ${randomUUID().slice(0, 4)}`);
    await checkReviewDuplicate(id, async () => { throw new Error("boom"); });
    assert.equal((await reviewRow(id)).duplicateOutcome, "unavailable");
  });
});

describe("a stale duplicate reads not checked", () => {
  it("a pending-review match holds only while the target is pending and still matches", async () => {
    const text = `{NAME} bottled lightning ${RUN}`;
    const target = await review(`${text}!`);
    const source = await review(text, { duplicateOutcome: "duplicate", matchingReviewId: target, duplicateCheckedAt: new Date() });
    const view = async () => duplicateView(await reviewRow(source));
    assert.deepEqual(await view(), { state: "duplicate", fact: null, review: { id: target, text: `${text}!` } });

    await db.update(pendingReviewsTable).set({ submittedText: `{NAME} bottled thunder ${RUN}` }).where(eq(pendingReviewsTable.id, target));
    assert.equal((await view()).state, "not_checked", "the target's wording was edited");

    await db.update(pendingReviewsTable).set({ submittedText: `${text}!`, status: "rejected" }).where(eq(pendingReviewsTable.id, target));
    assert.equal((await view()).state, "not_checked", "the target was resolved");
  });

  it("a fact match holds only while the fact is active, and absence is never distinct", async () => {
    const id = await fact(`{NAME} folded a mountain ${RUN}`);
    const source = await review(`{NAME} folds mountains ${RUN}`, { duplicateOutcome: "duplicate", matchingFactId: id, duplicateCheckedAt: new Date() });
    assert.equal((await duplicateView(await reviewRow(source))).state, "duplicate");
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, id));
    assert.equal((await duplicateView(await reviewRow(source))).state, "not_checked");

    const unchecked = await review(`{NAME} never checked ${RUN}`, { matchingSimilarity: 0 });
    assert.equal((await duplicateView(await reviewRow(unchecked))).state, "not_checked");
  });
});

// ── the routes ───────────────────────────────────────────────────────────────

/** The app's own detector (`app.locals.duplicateDetector`), so no global stub is shared. */
function withDetector<T extends { locals: Record<string, unknown> }>(app: T, detector: DuplicateDetector): T {
  app.locals["duplicateDetector"] = detector;
  return app;
}

describe("the routes", () => {
  it("a submission ignores browser-sent match fields; the server checks the saved wording after commit", async () => {
    const seen: string[] = [];
    const factId = await fact(`{NAME} unrelated ${RUN}`);
    const app = withDetector(buildTestApp({ kind: "authenticated", userId: adminId }, reviewsRouter),
      async (text) => { seen.push(text); return { outcome: "distinct", confidence: 12 }; });
    const text = `{NAME} submitted through the route ${RUN}`;
    const res = await request(app).post("/api/facts/submit-review")
      .send({ text, matchingFactId: factId, matchingSimilarity: 99, isDuplicate: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await __settleSubmitDuplicateChecksForTest();
    const row = await reviewRow(res.body.reviewId);
    assert.equal(row.duplicateOutcome, "distinct");
    assert.equal(row.matchingFactId, null, "the browser's match was discarded");
    assert.equal(row.matchingSimilarity, 12);
    assert.deepEqual(seen, [row.submittedText]);
  });

  it("the on-demand check is admin-only, spends only without a usable verdict, and returns the wording it belongs to", async () => {
    let calls = 0;
    const detector: DuplicateDetector = async () => { calls++; return { outcome: "distinct", confidence: 30 }; };
    const admin = withDetector(buildTestApp({ kind: "authenticated", userId: adminId }, reviewsRouter), detector);
    const user = withDetector(buildTestApp({ kind: "authenticated", userId }, reviewsRouter), detector);
    const text = `{NAME} opened at triage ${RUN}`;
    const id = await review(text);

    assert.equal((await request(user).post(`/api/admin/reviews/${id}/duplicate-check`)).status, 403);

    const first = await request(admin).post(`/api/admin/reviews/${id}/duplicate-check`);
    assert.equal(first.status, 200);
    assert.equal(first.body.submittedText, text);
    assert.equal(first.body.duplicate.state, "distinct");
    assert.equal(calls, 1);

    await request(admin).post(`/api/admin/reviews/${id}/duplicate-check`);
    assert.equal(calls, 1, "a usable verdict is not re-checked");

    await db.update(pendingReviewsTable).set({ duplicateOutcome: "unavailable" }).where(eq(pendingReviewsTable.id, id));
    await request(admin).post(`/api/admin/reviews/${id}/duplicate-check`);
    assert.equal(calls, 2, "couldn't-check is retried");

    const past = await review(`{NAME} past triage ${RUN}`, { workflowStage: "reading" });
    const r = await request(admin).post(`/api/admin/reviews/${past}/duplicate-check`);
    assert.equal(r.body.duplicate.state, "not_checked");
    assert.equal(calls, 2, "nothing is spent past triage");

    const detail = await request(admin).get(`/api/admin/reviews/${id}`);
    assert.equal(detail.body.duplicate.state, "distinct");
    const list = await request(admin).get(`/api/admin/reviews?status=pending&q=${encodeURIComponent(`opened at triage ${RUN}`)}`);
    assert.equal(list.body.reviews.find((x: { id: number }) => x.id === id)?.duplicate.state, "distinct");
  });

  it("a wording edit replaces the verdict with the wording", async () => {
    const admin = withDetector(buildTestApp({ kind: "authenticated", userId: adminId }, reviewsRouter),
      async () => ({ outcome: "unavailable", confidence: 0 }));
    const id = await review(`{NAME} before the edit ${RUN}`, { duplicateOutcome: "distinct", duplicateCheckedAt: new Date() });
    const res = await request(admin).post(`/api/admin/reviews/${id}/wording`).send({ text: `{NAME} after the edit ${RUN}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.duplicate.state, "unavailable");
    const row = await reviewRow(id);
    assert.equal(row.duplicateOutcome, "unavailable");
    assert.match(row.submittedText, /after the edit/);
  });
});
