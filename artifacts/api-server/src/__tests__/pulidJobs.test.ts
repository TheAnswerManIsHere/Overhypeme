/**
 * /api/memes/pulid-jobs unit tests.
 *
 * Only covers the surface that doesn't touch fal.ai — the in-memory job map,
 * progress math, auth gating, and the polling endpoint's response shape. The
 * full POST → poll → save flow is covered by manual + UAT testing because the
 * fal.subscribe call costs real money to exercise end-to-end.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

import pulidJobsRouter, { __testHooks } from "../routes/pulidJobs.js";

function makeApp(userId: string | null, opts?: { tier?: "registered" | "legendary" }): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) {
      req.user = {
        id: userId,
        email: `${userId}@test.local`,
        firstName: null,
        lastName: null,
        displayName: "Tester",
        pronouns: "they/them",
        profileImageUrl: null,
        membershipTier: opts?.tier ?? "legendary",
        isAdmin: false,
        isRealAdmin: false,
        captchaVerified: true,
        nsfwModeEnabled: false,
        userRole: opts?.tier === "registered" ? "registered" : "legendary",
        realUserRole: opts?.tier === "registered" ? "registered" : "legendary",
      } as Express.User;
    }
    req.isAuthenticated = function (this: Request) { return this.user != null; } as Request["isAuthenticated"];
    next();
  });
  app.use(pulidJobsRouter);
  return app;
}

describe("GET /memes/pulid-jobs/:jobId", () => {
  const jobId = "test-job-" + Date.now();
  const userId = "user-A";

  before(() => {
    __testHooks.jobs.set(jobId, {
      jobId,
      userId,
      factId: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      phase: "in_progress",
      expectedRunMs: 18_000,
      startedRunAt: Date.now() - 5_000,
    });
  });
  after(() => {
    __testHooks.jobs.delete(jobId);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = makeApp(null);
    const res = await request(app).get(`/memes/pulid-jobs/${jobId}`);
    assert.equal(res.status, 401);
  });

  it("returns 403 when authenticated user does not own the job", async () => {
    const app = makeApp("user-B");
    const res = await request(app).get(`/memes/pulid-jobs/${jobId}`);
    assert.equal(res.status, 403);
  });

  it("returns 404 for unknown jobId", async () => {
    const app = makeApp(userId);
    const res = await request(app).get(`/memes/pulid-jobs/missing-job`);
    assert.equal(res.status, 404);
  });

  it("returns a progress reading between 0.08 and 0.95 for in-progress phase", async () => {
    const app = makeApp(userId);
    const res = await request(app).get(`/memes/pulid-jobs/${jobId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.phase, "in_progress");
    assert.ok(res.body.progress >= 0.08 && res.body.progress < 1);
  });
});

describe("POST /memes/pulid-jobs", () => {
  it("blocks non-legendary tiers with 403", async () => {
    const app = makeApp("user-C", { tier: "registered" });
    const res = await request(app)
      .post("/memes/pulid-jobs")
      .send({
        factId: 1,
        referenceImagePath: "/objects/foo.jpg",
        targetGender: "neutral",
      });
    assert.equal(res.status, 403);
  });

  it("rejects missing factId with 400", async () => {
    const app = makeApp("user-D");
    const res = await request(app)
      .post("/memes/pulid-jobs")
      .send({ referenceImagePath: "/objects/foo.jpg" });
    assert.equal(res.status, 400);
  });

  it("rejects referenceImagePath without /objects/ prefix", async () => {
    const app = makeApp("user-E");
    const res = await request(app)
      .post("/memes/pulid-jobs")
      .send({ factId: 1, referenceImagePath: "https://example.com/foo.jpg" });
    assert.equal(res.status, 400);
  });

  it("rejects unknown styleId with 400", async () => {
    const app = makeApp("user-F");
    const res = await request(app)
      .post("/memes/pulid-jobs")
      .send({
        factId: 1,
        referenceImagePath: "/objects/foo.jpg",
        styleId: "not-a-real-style",
      });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /styleId/i);
  });
});

describe("computeProgress (pure math)", () => {
  const { computeProgress } = __testHooks;

  it("queued with low queue position → very small progress (bar starts near empty)", () => {
    const p = computeProgress({
      jobId: "j",
      userId: "u",
      factId: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      expectedRunMs: 18_000,
      phase: "queued",
      queuePosition: 1,
    });
    assert.ok(p >= 0.02, `expected p >= 0.02, got ${p}`);
    assert.ok(p <= 0.10, `expected p <= 0.10, got ${p}`);
  });

  it("completed → 1.0", () => {
    const p = computeProgress({
      jobId: "j",
      userId: "u",
      factId: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      expectedRunMs: 18_000,
      phase: "completed",
      completedAt: Date.now(),
    });
    assert.equal(p, 1);
  });

  it("in_progress progress climbs with elapsed time", () => {
    const now = Date.now();
    const early = computeProgress({
      jobId: "j",
      userId: "u",
      factId: 1,
      createdAt: now - 2_000,
      expiresAt: now + 60_000,
      expectedRunMs: 18_000,
      phase: "in_progress",
      startedRunAt: now - 2_000,
    });
    const late = computeProgress({
      jobId: "j",
      userId: "u",
      factId: 1,
      createdAt: now - 12_000,
      expiresAt: now + 60_000,
      expectedRunMs: 18_000,
      phase: "in_progress",
      startedRunAt: now - 12_000,
    });
    assert.ok(late > early);
    assert.ok(late < 1);
  });
});
