/**
 * GET /users/me/submissions and /users/me/submissions/counts (plan
 * PLAN_LIBRARY_SUBMISSIONS.md). The general property, over a generated mix of
 * every record shape a submission can have: each submission lands in exactly
 * one status, the counts equal the fully paged lists in both orders, search
 * counts equal search lists, and nothing of another member's ever appears.
 * Then the disclosure boundaries one at a time.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import express, { type Express } from "express";
import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, factsTable, commentsTable, pendingReviewsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { buildPlaceholderGag } from "@workspace/api-zod";
import { eq, inArray, like } from "drizzle-orm";

import usersRouter from "../routes/users.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { createSession, type SessionData } from "../lib/auth.js";

const USER_PREFIX = "t_mysubs_";
const TAG = `tmysubs${randomUUID().slice(0, 8)}`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(usersRouter);
  return app;
}

async function createUser(): Promise<{ id: string; bearer: string }> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({ id, email: `${id}@test.local`, membershipTier: "registered" });
  const sessionData: SessionData = { user: { id } as unknown as SessionData["user"], access_token: "test-token" };
  return { id, bearer: `Bearer ${await createSession(sessionData, id)}` };
}

async function cleanup() {
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(commentsTable).where(inArray(commentsTable.authorId, ids));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.submittedById, ids));
    await db.delete(factsTable).where(inArray(factsTable.submittedById, ids));
  }
  await db.delete(hashtagsTable).where(like(hashtagsTable.name, `${TAG}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

/** A small deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Status = "review" | "live" | "declined" | "gone";
const STATUSES: Status[] = ["review", "live", "declined", "gone"];

/** A few shared instants, so ties on the sort date are common and ids run against the dates. */
const INSTANTS = [
  "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.123Z", "2026-02-01T00:00:00.123Z",
  "2026-03-15T12:00:00.000Z", "2025-12-31T23:59:59.999Z",
].map((s) => new Date(s));

async function liveFact(userId: string, text: string, when: Date) {
  return insertLiveFact({ text, submittedById: userId, createdAt: when, approvedAt: when, approvalSource: "legacy" }, buildPlaceholderGag());
}

/**
 * Seeds every record shape for `userId` and returns what each type/status must
 * list, as `type:status -> [kind:id]`, derived from how each record was made
 * rather than from the code under test.
 */
async function seedMix(userId: string, seed: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const expected = new Map<string, Set<string>>();
  const expect = (type: string, status: Status, key: string) => {
    const k = `${type}:${status}`;
    if (!expected.has(k)) expected.set(k, new Set());
    expected.get(k)!.add(key);
  };

  // Pending reviews: more than one page, at every step.
  for (let i = 0; i < 30; i++) {
    const [row] = await db.insert(pendingReviewsTable).values({
      submittedText: `{NAME} pending ${i}`, submittedById: userId, status: "pending",
      workflowStage: pick(["triage", "reading", "gags", "test_renders"] as const), createdAt: pick(INSTANTS),
    }).returning({ id: pendingReviewsTable.id });
    expect("facts", "review", `review:${row!.id}`);
  }
  // Rejected reviews, some with no decision date.
  for (let i = 0; i < 7; i++) {
    const [row] = await db.insert(pendingReviewsTable).values({
      submittedText: `{NAME} rejected ${i}`, submittedById: userId, status: "rejected", workflowStage: "rejected",
      createdAt: pick(INSTANTS), reviewedAt: rand() < 0.3 ? null : pick(INSTANTS),
    }).returning({ id: pendingReviewsTable.id });
    expect("facts", "declined", `review:${row!.id}`);
  }
  // Live facts behind zero, one or two approved reviews (the approved reviews are never listed).
  const liveIds: number[] = [];
  for (let i = 0; i < 26; i++) {
    const fact = await liveFact(userId, `{NAME} live ${i}`, pick(INSTANTS));
    liveIds.push(fact.id);
    expect("facts", "live", `fact:${fact.id}`);
    for (let k = 0; k < i % 3; k++) {
      await db.insert(pendingReviewsTable).values({
        submittedText: `{NAME} live ${i}`, submittedById: userId, status: "approved", workflowStage: "approved",
        approvedFactId: fact.id, stagingFactId: fact.id,
      });
    }
  }
  // Approved facts since taken down.
  const goneIds: number[] = [];
  for (let i = 0; i < 4; i++) {
    const fact = await liveFact(userId, `{NAME} gone ${i}`, pick(INSTANTS));
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, fact.id));
    goneIds.push(fact.id);
    expect("facts", "gone", `fact_gone:${fact.id}`);
  }
  // A staging fact behind a pending review: the review is listed, the fact never.
  const [staging] = await db.insert(factsTable).values({ text: "{NAME} staging", submittedById: userId }).returning({ id: factsTable.id });
  const [stagingReview] = await db.insert(pendingReviewsTable).values({
    submittedText: "{NAME} staging", submittedById: userId, status: "pending", workflowStage: "gags", stagingFactId: staging!.id,
  }).returning({ id: pendingReviewsTable.id });
  expect("facts", "review", `review:${stagingReview!.id}`);

  // Comments in every state, on live and taken-down facts, including a status
  // no code writes: it must read as Under Review, never as live.
  const shapes: { status: string; flagged: boolean; on: "live" | "gone"; is: Status }[] = [
    { status: "pending", flagged: false, on: "live", is: "review" },
    { status: "pending", flagged: false, on: "gone", is: "review" },
    { status: "approved", flagged: false, on: "live", is: "live" },
    { status: "approved", flagged: true, on: "live", is: "review" },
    { status: "approved", flagged: false, on: "gone", is: "gone" },
    { status: "approved", flagged: true, on: "gone", is: "review" },
    { status: "rejected", flagged: true, on: "live", is: "declined" },
    { status: "rejected", flagged: false, on: "gone", is: "declined" },
    { status: "weird", flagged: false, on: "live", is: "review" },
  ];
  for (let i = 0; i < 40; i++) {
    const shape = shapes[i % shapes.length]!;
    const [row] = await db.insert(commentsTable).values({
      factId: shape.on === "live" ? pick(liveIds) : pick(goneIds), authorId: userId,
      text: `comment ${i}`, status: shape.status, flagged: shape.flagged, createdAt: pick(INSTANTS),
    }).returning({ id: commentsTable.id });
    expect("comments", shape.is, `comment:${row!.id}`);
  }
  return expected;
}

async function pageAll(app: Express, bearer: string, params: Record<string, string>) {
  const keys: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const res = await request(app).get("/users/me/submissions").set("authorization", bearer)
      .query({ ...params, ...(cursor ? { cursor } : {}) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    keys.push(...res.body.items.map((i: { kind: string; id: number }) => `${i.kind}:${i.id}`));
    cursor = res.body.nextCursor;
    if (!cursor) return keys;
  }
  throw new Error("paging did not end");
}

describe("GET /users/me/submissions — refusals", () => {
  it("refuses without a session", async () => {
    const app = makeApp();
    assert.equal((await request(app).get("/users/me/submissions?type=facts&status=review")).status, 401);
    assert.equal((await request(app).get("/users/me/submissions/counts")).status, 401);
  });

  it("refuses an unknown type or status", async () => {
    const { bearer } = await createUser();
    const app = makeApp();
    assert.equal((await request(app).get("/users/me/submissions?type=memes&status=review").set("authorization", bearer)).status, 400);
    assert.equal((await request(app).get("/users/me/submissions?type=facts&status=pending").set("authorization", bearer)).status, 400);
  });
});

describe("GET /users/me/submissions — one status per submission, counts equal lists", () => {
  it("holds across a generated mix of every record shape, in both orders, and never shows another member's", async () => {
    const owner = await createUser();
    const other = await createUser();
    const expected = await seedMix(owner.id, 1090);
    await seedMix(other.id, 7);
    const app = makeApp();

    const counts = await request(app).get("/users/me/submissions/counts").set("authorization", owner.bearer);
    assert.equal(counts.status, 200);
    assert.equal(counts.body.matches, null);

    for (const type of ["facts", "comments"] as const) {
      const seen = new Set<string>();
      for (const status of STATUSES) {
        const want = expected.get(`${type}:${status}`) ?? new Set<string>();
        const newest = await pageAll(app, owner.bearer, { type, status });
        const oldest = await pageAll(app, owner.bearer, { type, status, sort: "oldest" });

        assert.equal(new Set(newest).size, newest.length, `${type}:${status} repeats an item (newest)`);
        assert.equal(new Set(oldest).size, oldest.length, `${type}:${status} repeats an item (oldest)`);
        assert.deepEqual(new Set(newest), want, `${type}:${status} lists exactly its submissions`);
        assert.deepEqual([...oldest].reverse(), newest, `${type}:${status}: oldest is newest reversed`);
        assert.equal(counts.body.totals[type][status], want.size, `${type}:${status} count`);

        for (const key of newest) {
          assert.ok(!seen.has(key), `${key} appears in two statuses`);
          seen.add(key);
        }
      }
    }
  });
});

describe("GET /users/me/submissions — search", () => {
  it("matches every word in any order, by wording or hashtag, literally, and its counts equal its lists", async () => {
    const { id, bearer } = await createUser();
    const app = makeApp();
    await db.insert(pendingReviewsTable).values([
      { submittedText: "{NAME} {lifts|lift} the moon", submittedById: id, hashtags: [`${TAG}strength`] },
      { submittedText: "{NAME} is 100% legend", submittedById: id, status: "rejected", workflowStage: "rejected" },
      { submittedText: "{NAME} hums the moon to sleep", submittedById: id },
    ]);
    const live = await liveFact(id, "{NAME} outran the sun", new Date());
    const [tag] = await db.insert(hashtagsTable).values({ name: `${TAG}speed` }).returning();
    await db.insert(factHashtagsTable).values({ factId: live.id, hashtagId: tag!.id });
    await db.insert(commentsTable).values({ factId: live.id, authorId: id, text: "the moon agrees", status: "approved" });

    const cases: { q: string; facts: Partial<Record<Status, number>>; comments: Partial<Record<Status, number>> }[] = [
      { q: "moon the lifts", facts: { review: 1 }, comments: {} },
      { q: "moon", facts: { review: 2 }, comments: { live: 1 } },
      { q: `#${TAG}speed`, facts: { live: 1 }, comments: {} },
      { q: `${TAG}strength`, facts: { review: 1 }, comments: {} },
      { q: "100%", facts: { declined: 1 }, comments: {} },
      { q: "%", facts: { declined: 1 }, comments: {} },
      { q: "_", facts: {}, comments: {} },
    ];
    for (const c of cases) {
      const res = await request(app).get("/users/me/submissions/counts").set("authorization", bearer).query({ q: c.q });
      assert.equal(res.status, 200);
      for (const type of ["facts", "comments"] as const) {
        for (const status of STATUSES) {
          const want = c[type][status] ?? 0;
          assert.equal(res.body.matches[type][status], want, `"${c.q}" ${type}:${status} count`);
          const listed = await pageAll(app, bearer, { type, status, q: c.q });
          assert.equal(listed.length, want, `"${c.q}" ${type}:${status} list`);
        }
      }
      // Totals do not move while searching.
      assert.equal(res.body.totals.facts.review, 2);
    }
  });
});

describe("GET /users/me/submissions — what each card may show", () => {
  it("shows a declined fact's reason and note (Issue #1057)", async () => {
    const { id, bearer } = await createUser();
    await db.insert(pendingReviewsTable).values({
      submittedText: "{NAME} once declined a rejection.", submittedById: id, status: "rejected", workflowStage: "rejected",
      reason: "visual", adminNote: "We tried three framings and none of them landed.",
    });
    const res = await request(makeApp()).get("/users/me/submissions?type=facts&status=declined").set("authorization", bearer);
    const [sub] = res.body.items;
    assert.equal(sub.kind, "review");
    assert.equal(sub.reason, "visual");
    assert.equal(sub.teamNote, "We tried three framings and none of them landed.");
    assert.equal(sub.progress, null);
  });

  it("withholds a draft reason and note on a fact still in review, and says how far it has got", async () => {
    const { id, bearer } = await createUser();
    await db.insert(pendingReviewsTable).values([
      { submittedText: "{NAME} first", submittedById: id, workflowStage: "triage", reason: "lame", adminNote: "Draft: leaning no." },
      { submittedText: "{NAME} second", submittedById: id, workflowStage: "test_renders", reason: "lame", adminNote: "Draft." },
    ]);
    const res = await request(makeApp()).get("/users/me/submissions?type=facts&status=review&sort=oldest").set("authorization", bearer);
    assert.equal(res.status, 200);
    for (const sub of res.body.items) {
      assert.equal(sub.reason, null);
      assert.equal(sub.teamNote, null);
      assert.equal("workflowStage" in sub, false);
    }
    const byText = new Map(res.body.items.map((s: { text: string; progress: string }) => [s.text, s.progress]));
    assert.equal(byText.get("{NAME} first"), "first_look");
    assert.equal(byText.get("{NAME} second"), "preparing");
  });

  it("shows a declined comment's note, marks a hidden one, and never shows a flag's explanation otherwise", async () => {
    const { id, bearer } = await createUser();
    const fact = await liveFact(id, "{NAME} has opinions", new Date());
    await db.insert(commentsTable).values([
      { factId: fact.id, authorId: id, text: "declined one", status: "rejected", flagged: true, flagReason: "Off topic." },
      { factId: fact.id, authorId: id, text: "hidden one", status: "approved", flagged: true, flagReason: "Spam detected by AI" },
    ]);
    const app = makeApp();
    const declined = await request(app).get("/users/me/submissions?type=comments&status=declined").set("authorization", bearer);
    assert.equal(declined.body.items[0].teamNote, "Off topic.");
    const review = await request(app).get("/users/me/submissions?type=comments&status=review").set("authorization", bearer);
    assert.equal(review.body.items[0].hidden, true);
    assert.equal(review.body.items[0].teamNote, null);
    assert.equal(review.body.items[0].factLive, true);
  });

  it("returns a live fact as the full fact summary", async () => {
    const { id, bearer } = await createUser();
    const fact = await liveFact(id, "{NAME} is live", new Date());
    const res = await request(makeApp()).get("/users/me/submissions?type=facts&status=live").set("authorization", bearer);
    const [sub] = res.body.items;
    assert.equal(sub.kind, "fact");
    assert.equal(sub.fact.id, fact.id);
    assert.equal(sub.fact.text, "{NAME} is live");
    assert.ok(sub.decidedAt);
  });
});
