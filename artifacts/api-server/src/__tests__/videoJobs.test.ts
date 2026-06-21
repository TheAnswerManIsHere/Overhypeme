/**
 * Integration tests for the async video pipeline (/api/memes/video-jobs).
 *
 * Talks to the real dev database via the same `t-vj-` prefix-and-cleanup
 * convention as the other route tests. The fal.ai calls (PuLID, video gen,
 * subtitle, R2 upload) are stubbed via __setPipelineTestHooks so no network
 * traffic leaves the box.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  videoJobsTable,
  memesTable,
  uploadImageMetadataTable,
  userGenerationCostsTable,
  lookStylesTable,
} from "@workspace/db/schema";
import { eq, like, inArray } from "drizzle-orm";

import videoJobsRouter from "../routes/videoJobs.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import {
  __setPipelineTestHooks,
  __resetPipelineState,
  __computeProgressForTests,
  type JobState,
} from "../lib/videoPipelineRunner.js";

const USER_PREFIX = "t-vj-";
const FACT_TEXT_PREFIX = "t-vj-fact ";

function uid(): string {
  return `${USER_PREFIX}${randomUUID()}`;
}

const insertedFactIds: number[] = [];
const insertedUserIds: string[] = [];
const seededLookStyleIds: string[] = [];

async function createTestUser(opts: { tier?: "registered" | "legendary" | "unregistered"; isAdmin?: boolean } = {}): Promise<string> {
  const id = uid();
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.tier ?? "legendary",
    isAdmin: opts.isAdmin ?? false,
  });
  insertedUserIds.push(id);
  return id;
}

async function insertFact(): Promise<number> {
  const [row] = await db
    .insert(factsTable)
    .values({ text: `${FACT_TEXT_PREFIX}{NAME}`, isActive: true, canonicalText: FACT_TEXT_PREFIX })
    .returning();
  insertedFactIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (insertedUserIds.length > 0) {
    await db
      .delete(userGenerationCostsTable)
      .where(inArray(userGenerationCostsTable.userId, insertedUserIds));
    await db
      .delete(memesTable)
      .where(inArray(memesTable.createdById, insertedUserIds));
    await db
      .delete(videoJobsTable)
      .where(inArray(videoJobsTable.userId, insertedUserIds));
    await db
      .delete(uploadImageMetadataTable)
      .where(inArray(uploadImageMetadataTable.userId, insertedUserIds));
  }
  // Prefix-based cleanup catches both in-flight facts and orphans from a crashed run.
  const orphanFactIds = (await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(like(factsTable.text, `${FACT_TEXT_PREFIX}%`)))
    .map((r) => r.id);
  if (orphanFactIds.length > 0) {
    await db.delete(memesTable).where(inArray(memesTable.factId, orphanFactIds));
    await db.delete(videoJobsTable).where(inArray(videoJobsTable.factId, orphanFactIds));
    await db.delete(factsTable).where(inArray(factsTable.id, orphanFactIds));
  }
  insertedFactIds.length = 0;
  // ledger rows tagged with the test prefix
  await db
    .delete(userGenerationCostsTable)
    .where(like(userGenerationCostsTable.userId, `${USER_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  insertedUserIds.length = 0;
  // Remove look styles that were seeded by this test suite
  if (seededLookStyleIds.length > 0) {
    await db.delete(lookStylesTable).where(inArray(lookStylesTable.id, seededLookStyleIds));
    seededLookStyleIds.length = 0;
  }
}

/**
 * Seed the look styles needed by this test suite into the test DB.
 * Uses onConflictDoNothing so it is idempotent; tracks only the rows that
 * were actually inserted so cleanup never deletes pre-existing prod rows.
 */
async function seedLookStyles(): Promise<void> {
  const needed = [
    { id: "cinematic", label: "Cinematic", isActive: true as const },
    { id: "anime", label: "Anime", isActive: true as const },
  ];
  for (const ls of needed) {
    const [inserted] = await db
      .insert(lookStylesTable)
      .values(ls)
      .onConflictDoNothing()
      .returning({ id: lookStylesTable.id });
    if (inserted) seededLookStyleIds.push(inserted.id);
  }
}

async function waitForPhase(
  poll: () => Promise<{ phase?: string } | null>,
  phases: string[],
  timeoutMs = 2000,
): Promise<{ phase?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await poll();
    if (state && state.phase && phases.includes(state.phase)) return state;
    await new Promise(r => setTimeout(r, 20));
  }
  return null;
}

before(async () => {
  await cleanup();
  await seedLookStyles();
});
after(cleanup);
beforeEach(() => __resetPipelineState());
afterEach(() => {
  __resetPipelineState();
  __setPipelineTestHooks({});
});

describe("POST /api/memes/video-jobs", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, videoJobsRouter);
    const res = await request(app).post("/api/memes/video-jobs").send({
      factId: 1,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/test.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(res.status, 401);
  });

  it("returns 403 VIDEO_GENERATION_LOCKED for a non-legendary user", async () => {
    const userId = await createTestUser({ tier: "registered" });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);
    const res = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/test.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "VIDEO_GENERATION_LOCKED");
  });

  it("happy path: returns 200 {jobId} and transitions through stage1 → stage1_review", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: "/objects/styled.jpg" }),
      classifyStill: async () => "accept",
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(startRes.status, 200);
    assert.ok(typeof startRes.body.jobId === "string");

    const jobId = startRes.body.jobId;
    const state = await waitForPhase(
      async () => {
        const r = await request(app).get(`/api/memes/video-jobs/${jobId}`);
        return r.body;
      },
      ["stage1_review", "failed"],
    );
    assert.ok(state, "expected a phase update within timeout");
    assert.equal(state!.phase, "stage1_review");
  });

  it("threads aspectRatio + framingFocus into the Stage-1 job state", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    let capturedAspect: string | undefined;
    let capturedFocus: unknown;
    let stage1Ran = false;
    __setPipelineTestHooks({
      runStage1: async (job) => {
        capturedAspect = job.aspectRatio;
        capturedFocus = job.framingFocus;
        stage1Ran = true;
        return { stillObjectPath: "/objects/styled.jpg" };
      },
      classifyStill: async () => "accept",
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "portrait",
      framingFocus: { x: 0.25, y: 0.75 },
    });
    assert.equal(startRes.status, 200);

    const jobId = startRes.body.jobId;
    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage1_review", "failed"],
    );
    assert.ok(stage1Ran, "runStage1 should have been called");
    assert.equal(capturedAspect, "portrait");
    assert.deepEqual(capturedFocus, { x: 0.25, y: 0.75 });
  });

  it("rejects an out-of-range framingFocus with 400", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);
    const res = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "portrait",
      framingFocus: { x: 1.5, y: 0.5 },
    });
    assert.equal(res.status, 400);
  });

  it("source mode 'use-photo-as-is' skips stage1_pulid entirely", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    let stage1Called = false;
    __setPipelineTestHooks({
      runStage1: async () => {
        stage1Called = true;
        return { stillObjectPath: "/objects/styled.jpg" };
      },
      classifyStill: async () => "accept",
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "use-photo-as-is",
      sourceImagePath: "/objects/source.jpg",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(startRes.status, 200);

    const jobId = startRes.body.jobId;
    const state = await waitForPhase(
      async () => {
        const r = await request(app).get(`/api/memes/video-jobs/${jobId}`);
        return r.body;
      },
      ["stage1_review"],
    );
    assert.equal(state!.phase, "stage1_review");
    assert.equal(stage1Called, false, "stage 1 must be skipped for use-photo-as-is");
  });

  it("no-face during stage 1 routes to stage1_no_face_review (not failed)", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: null }),
      classifyStill: async () => "accept",
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(startRes.status, 200);
    const jobId = startRes.body.jobId;

    const state = await waitForPhase(
      async () => {
        const r = await request(app).get(`/api/memes/video-jobs/${jobId}`);
        return r.body;
      },
      ["stage1_no_face_review", "failed"],
    );
    assert.equal(state!.phase, "stage1_no_face_review");
  });

  it("no-face fallback generates a text-to-image still and feeds it to stage 2", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    let stage2Still: string | undefined;
    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: null }),
      runStage1Fallback: async () => ({ stillObjectPath: "/objects/abstract-scene.jpg" }),
      classifyStill: async () => "accept",
      runStage2: async (_job, still) => {
        stage2Still = still;
        // Abort here so the pipeline halts at stage2_video for the assertion.
        throw new Error("stage 2 stub aborts");
      },
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    const jobId = startRes.body.jobId;
    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage1_no_face_review", "failed"],
    );

    const fbRes = await request(app)
      .post(`/api/memes/video-jobs/${jobId}/proceed-with-no-face-fallback`)
      .send({});
    assert.equal(fbRes.status, 200);

    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage2_video", "failed"],
    );
    // The generated faceless still — NOT the raw uploaded photo — is what
    // Stage 2 animates.
    assert.equal(stage2Still, "/objects/abstract-scene.jpg");
  });

  it("NSFW classifier hit on stylized still → failed with errorCode=moderation", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: "/objects/styled.jpg" }),
      classifyStill: async () => "reject",
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    const jobId = startRes.body.jobId;

    const state = await waitForPhase(
      async () => {
        const r = await request(app).get(`/api/memes/video-jobs/${jobId}`);
        return r.body;
      },
      ["failed", "stage1_review"],
    );
    assert.equal(state!.phase, "failed");
    assert.equal((state as { errorCode?: string }).errorCode, "moderation");
  });

  it("rejects invalid engine duration with 400", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);
    const res = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "use-photo-as-is",
      sourceImagePath: "/objects/source.jpg",
      lengthSeconds: 30, // valid zod range but not in any engine's allowedDurationsSec
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_engine_params");
  });
});

describe("GET /api/memes/video-jobs/:jobId", () => {
  it("returns 404 for a non-owner", async () => {
    const ownerId = await createTestUser({ tier: "legendary", isAdmin: true });
    const otherId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();

    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: "/objects/styled.jpg" }),
      classifyStill: async () => "accept",
    });

    const ownerApp = buildTestApp({ kind: "authenticated", userId: ownerId }, videoJobsRouter);
    const startRes = await request(ownerApp).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "use-photo-as-is",
      sourceImagePath: "/objects/source.jpg",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(startRes.status, 200);
    const jobId = startRes.body.jobId;

    const otherApp = buildTestApp({ kind: "authenticated", userId: otherId }, videoJobsRouter);
    const peekRes = await request(otherApp).get(`/api/memes/video-jobs/${jobId}`);
    assert.equal(peekRes.status, 404);
  });
});

describe("POST /api/memes/video-jobs/:jobId/proceed", () => {
  it("advances stage1_review → stage2_video", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    let stage2Reached = false;
    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: "/objects/styled.jpg" }),
      classifyStill: async () => "accept",
      runStage2: async () => {
        stage2Reached = true;
        // Throw to keep the pipeline from advancing past stage2_video so the
        // assertion below can observe the phase transition itself.
        throw new Error("stage 2 stub aborts");
      },
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    const jobId = startRes.body.jobId;
    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage1_review"],
    );

    const proceedRes = await request(app)
      .post(`/api/memes/video-jobs/${jobId}/proceed`)
      .send({});
    assert.equal(proceedRes.status, 200);
    assert.equal(proceedRes.body.ok, true);

    // After proceed, the runner enters stage2_video synchronously (then fails
    // because the stub throws). Either we observe stage2_video or the
    // subsequent failure — both prove the proceed advanced past the checkpoint.
    const state = await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage2_video", "failed"],
    );
    assert.ok(state, "expected stage2 phase or failure after proceed");
    assert.equal(stage2Reached, true);
  });
});

describe("stage 2 fal.ai 422 error handling", () => {
  // Builds a fal.ai-shaped error: the client throws an Error-like object with
  // a numeric `status` and a `body.detail[]` array (see fal.ai docs).
  function makeFal422(detailType: string, msg = "model rejected"): Error {
    const err = new Error("Unprocessable Entity") as Error & {
      status: number;
      body: { detail: Array<{ type: string; msg: string; loc: string[] }> };
    };
    err.status = 422;
    err.body = { detail: [{ type: detailType, msg, loc: ["body"] }] };
    return err;
  }

  async function startAndAdvanceToStage2(userId: string, factId: number, runStage2: () => Promise<never>): Promise<{ jobId: string; app: ReturnType<typeof buildTestApp> }> {
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);
    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: "/objects/styled.jpg" }),
      classifyStill: async () => "accept",
      runStage2,
    });
    // Both source modes pause at stage1_review awaiting an explicit /proceed
    // call (same pattern as the existing "advances stage1_review → stage2_video"
    // test). After /proceed the runner enters stage2 and our stub throws.
    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    assert.equal(startRes.status, 200);
    const jobId = startRes.body.jobId;
    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage1_review"],
    );
    const proceedRes = await request(app).post(`/api/memes/video-jobs/${jobId}/proceed`).send({});
    assert.equal(proceedRes.status, 200);
    return { jobId, app };
  }

  it("fal.ai 422 no_media_generated → errorCode=moderation (matches dedicated 'pick a different photo' screen)", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const { jobId, app } = await startAndAdvanceToStage2(userId, factId, async () => {
      throw makeFal422("no_media_generated", "The model did not generate the expected output for this prompt.");
    });
    const state = await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["failed"],
    );
    assert.equal(state!.phase, "failed");
    assert.equal((state as { errorCode?: string }).errorCode, "moderation");
  });

  it("fal.ai 422 with other detail type → errorCode=stage2_failed + friendly message", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const { jobId, app } = await startAndAdvanceToStage2(userId, factId, async () => {
      throw makeFal422("file_download_error", "couldn't fetch image");
    });
    const state = await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["failed"],
    );
    assert.equal(state!.phase, "failed");
    assert.equal((state as { errorCode?: string }).errorCode, "stage2_failed");
    // friendly message — not the raw "Unprocessable Entity"
    const msg = (state as { errorMessage?: string }).errorMessage ?? "";
    assert.ok(msg.includes("try a different photo"), `expected friendly message, got: ${msg}`);
  });

  it("non-422 error → errorCode=stage2_failed + raw error message preserved", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const { jobId, app } = await startAndAdvanceToStage2(userId, factId, async () => {
      throw new Error("ECONNRESET");
    });
    const state = await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["failed"],
    );
    assert.equal(state!.phase, "failed");
    assert.equal((state as { errorCode?: string }).errorCode, "stage2_failed");
    assert.equal((state as { errorMessage?: string }).errorMessage, "ECONNRESET");
  });
});

describe("POST /api/memes/video-jobs/:jobId/regenerate", () => {
  it("re-runs stage 1 with a new lookStyleId", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    let lookStyleSeenInLastCall: string | null = null;
    __setPipelineTestHooks({
      runStage1: async (job: JobState) => {
        lookStyleSeenInLastCall = job.lookStyleId;
        return { stillObjectPath: "/objects/styled.jpg" };
      },
      classifyStill: async () => "accept",
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    const jobId = startRes.body.jobId;
    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage1_review"],
    );
    assert.equal(lookStyleSeenInLastCall, "cinematic");

    const regenRes = await request(app)
      .post(`/api/memes/video-jobs/${jobId}/regenerate`)
      .send({ lookStyleId: "anime" });
    assert.equal(regenRes.status, 200);

    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage1_review"],
    );
    assert.equal(lookStyleSeenInLastCall, "anime");
  });
});

describe("computeProgress — _falProgressFloor behavior (Part 2)", () => {
  // Fixture builder for a JobState with sensible defaults — phase + floor are
  // the axes under test; everything else is filler the function ignores.
  function fixture(overrides: Partial<JobState>): JobState {
    return {
      jobId: "j-test",
      userId: "u-test",
      factId: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/src.jpg",
      lookStyleId: "cinematic",
      motionPresetId: null,
      videoEngineId: "veo-3.1-lite",
      engineMode: null,
      customModePrompt: null,
      durationSec: 6,
      resolution: "720p",
      aspectRatio: "landscape",
      name: null,
      pronouns: null,
      stage1Attempts: 0,
      renderedFactText: null,
      phase: "queued",
      progress: 0,
      etaSeconds: undefined,
      _phaseStartedAt: Date.now(),
      _falProgressFloor: undefined,
      videoJobRowId: null,
      ...overrides,
    } as unknown as JobState;
  }

  it("during stage1_pulid: returns floor when above the elapsed-time curve", () => {
    const job = fixture({
      phase: "stage1_pulid",
      _phaseStartedAt: Date.now(),       // elapsed ≈ 0 → curve ≈ 0.013
      _falProgressFloor: 0.18,
    });
    const progress = __computeProgressForTests(job);
    assert.ok(progress >= 0.18, `expected ≥0.18, got ${progress}`);
    assert.ok(progress <= 0.25, `should stay inside the stage-1 slice, got ${progress}`);
  });

  it("during stage2_video (stylize-then-video): returns floor inside the 0.25..0.85 slice", () => {
    const job = fixture({
      phase: "stage2_video",
      _phaseStartedAt: Date.now(),
      _falProgressFloor: 0.55,
    });
    const progress = __computeProgressForTests(job);
    assert.ok(progress >= 0.55, `expected ≥0.55, got ${progress}`);
  });

  it("during stage2_video (bypass): floor occupies 0..0.85 because stage 1 was skipped", () => {
    const job = fixture({
      phase: "stage2_video",
      sourceMode: "use-photo-as-is",
      _phaseStartedAt: Date.now(),
      _falProgressFloor: 0.40,
    });
    const progress = __computeProgressForTests(job);
    assert.ok(progress >= 0.40, `expected ≥0.40, got ${progress}`);
  });

  it("during stage2_subtitle: floor inside the 0.85..0.95 slice", () => {
    const job = fixture({
      phase: "stage2_subtitle",
      _phaseStartedAt: Date.now(),
      _falProgressFloor: 0.92,
    });
    const progress = __computeProgressForTests(job);
    assert.ok(progress >= 0.92, `expected ≥0.92, got ${progress}`);
    assert.ok(progress < 1, `should stay below 1.0, got ${progress}`);
  });

  it("ignores _falProgressFloor on checkpoint pause (stage1_review)", () => {
    // The checkpoint is an intentional pause; the bar deliberately freezes at
    // 0.25 so the user can review the still. A leftover floor must NOT bypass
    // it. The runner clears the floor on setPhase regardless; this is the
    // belt-and-suspenders check.
    const job = fixture({
      phase: "stage1_review",
      _falProgressFloor: 0.80,
    });
    assert.equal(__computeProgressForTests(job), 0.25);
  });

  it("ignores _falProgressFloor on terminal states", () => {
    const completed = fixture({ phase: "completed", _falProgressFloor: 0.50 });
    assert.equal(__computeProgressForTests(completed), 1);

    const failed = fixture({ phase: "failed", progress: 0.30, _falProgressFloor: 0.90 });
    assert.equal(__computeProgressForTests(failed), 0.30);
  });

  it("uses the elapsed-time curve when no floor is set", () => {
    // Sanity check that we didn't regress the existing behavior.
    const job = fixture({
      phase: "stage1_pulid",
      _phaseStartedAt: Date.now() - 9_000,    // ~half of stage1Ema (18000)
      _falProgressFloor: undefined,
    });
    const progress = __computeProgressForTests(job);
    assert.ok(progress > 0.03, `curve should have advanced, got ${progress}`);
    assert.ok(progress < 0.25, `curve should be inside stage-1 slice, got ${progress}`);
  });
});

describe("DELETE /api/memes/video-jobs/:jobId", () => {
  it("marks the job canceled and reports promoted still path", async () => {
    const userId = await createTestUser({ tier: "legendary", isAdmin: true });
    const factId = await insertFact();
    const app = buildTestApp({ kind: "authenticated", userId }, videoJobsRouter);

    __setPipelineTestHooks({
      runStage1: async () => ({ stillObjectPath: "/objects/styled.jpg" }),
      classifyStill: async () => "accept",
    });

    const startRes = await request(app).post("/api/memes/video-jobs").send({
      factId,
      sourceMode: "stylize-then-video",
      sourceImagePath: "/objects/source.jpg",
      lookStyleId: "cinematic",
      lengthSeconds: 4,
      resolution: "720p",
      aspectRatio: "landscape",
    });
    const jobId = startRes.body.jobId;
    await waitForPhase(
      async () => (await request(app).get(`/api/memes/video-jobs/${jobId}`)).body,
      ["stage1_review"],
    );

    const cancelRes = await request(app).delete(`/api/memes/video-jobs/${jobId}`);
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.ok, true);
    assert.equal(cancelRes.body.promotedStillObjectPath, "/objects/styled.jpg");

    const peekRes = await request(app).get(`/api/memes/video-jobs/${jobId}`);
    assert.equal(peekRes.status, 200);
    assert.equal(peekRes.body.phase, "canceled");
  });
});
