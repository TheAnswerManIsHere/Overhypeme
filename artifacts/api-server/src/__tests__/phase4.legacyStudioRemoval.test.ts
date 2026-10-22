/**
 * Launch Phase 4, removal 1 — the legacy meme studio is gone (#744; plan
 * docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
 *
 * Pins three things:
 *   1. Every route only the studio called answers 404 through the whole app.
 *   2. The user generate route survives for its one live caller (the meme-page
 *      remix builder's stylise toggle), photo-only: a request with no reference
 *      photo is refused before the governance gate, and one with a photo still
 *      reaches the reference branch.
 *   3. Migration 0102 retires exactly the studio's nonterminal render jobs, by
 *      provenance, and leaves moderation, single-review and eval renders in the
 *      same queues alone. Idempotent.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db } from "@workspace/db";
import {
  usersTable,
  factsTable,
  pendingReviewsTable,
  imagePromptAttemptsTable,
  asyncJobsTable,
  evalRunsTable,
} from "@workspace/db/schema";
import { eq, inArray, like, sql } from "drizzle-orm";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, "../../../../lib/db/migrations/0102_retire_legacy_studio_render_jobs.sql"),
  "utf8",
);

const USER_PREFIX = "t_p4r1_";
const factIds: number[] = [];
const jobIds: number[] = [];
let legendaryId: string;
let legendarySid: string;
let activeFactId: number;

async function createUser(): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: true,
    membershipTier: "legendary",
    captchaVerified: true,
  });
  return id;
}

async function bearer(userId: string): Promise<string> {
  const data: SessionData = {
    user: { id: userId, membershipTier: "legendary" } as unknown as SessionData["user"],
    access_token: "test-token",
    isAdmin: true,
    captchaVerified: true,
  };
  return createSession(data, userId);
}

async function cleanup() {
  if (jobIds.length) await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, jobIds));
  if (factIds.length) {
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(evalRunsTable).where(like(evalRunsTable.label, `${USER_PREFIX}%`));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
  jobIds.length = 0;
  factIds.length = 0;
}

before(async () => {
  await cleanup();
  legendaryId = await createUser();
  legendarySid = await bearer(legendaryId);
  const [fact] = await db
    .insert(factsTable)
    .values({ text: "{NAME} outran a sunrise.", submittedById: legendaryId, isActive: true, enrichment: buildPlaceholderFactEnrichment() })
    .returning({ id: factsTable.id });
  activeFactId = fact!.id;
  factIds.push(activeFactId);
});

after(cleanup);

describe("routes only the legacy studio called are gone", () => {
  const gone: Array<[method: "get" | "post" | "delete", url: () => string]> = [
    ["get", () => `/api/memes/ai/${activeFactId}/image?gender=male&imageIndex=0`],
    ["delete", () => `/api/memes/ai/${activeFactId}/image?gender=male&imageIndex=0`],
    ["get", () => `/api/memes/ai/${activeFactId}/prompts`],
    ["post", () => `/api/memes/ai/${activeFactId}/regenerate-scene-prompts`],
    ["post", () => `/api/memes/ai/${activeFactId}/analyze-source`],
    ["post", () => `/api/memes/ai/${activeFactId}/generate-v2`],
    ["get", () => `/api/memes/ai/renders/${randomUUID()}`],
  ];
  for (const [method, url] of gone) {
    it(`${method.toUpperCase()} ${url().replace(String(activeFactId), ":factId")} answers 404, even to an entitled admin`, async () => {
      const res = await request(createApp())[method](url()).set("Authorization", `Bearer ${legendarySid}`).send({});
      assert.equal(res.status, 404);
    });
  }
});

describe("the user generate route is photo-only", () => {
  it("refuses a request with no reference photo, before any provider work", async () => {
    const res = await request(createApp())
      .post(`/api/memes/ai/${activeFactId}/generate`)
      .set("Authorization", `Bearer ${legendarySid}`)
      .send({ styleId: "none" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "reference_image_required");
  });

  it("still serves the remix builder's photo path (an unowned photo is refused by the reference branch)", async () => {
    const res = await request(createApp())
      .post(`/api/memes/ai/${activeFactId}/generate`)
      .set("Authorization", `Bearer ${legendarySid}`)
      .send({ referenceImagePath: `/objects/uploads/${randomUUID()}.jpg`, targetGender: "neutral" });
    assert.equal(res.status, 403);
    assert.match(String(res.body.error), /not found in your uploads/);
  });
});

describe("migration 0102 retires the studio's render jobs by provenance", () => {
  type Kind = "studio" | "scenario" | "single-review" | "eval";
  const attempts = new Map<Kind, number>();
  const jobs: Record<string, number> = {};

  async function seedAttempt(kind: Kind, reviewId: number | null, evalRunId: number | null): Promise<number> {
    const [row] = await db
      .insert(imagePromptAttemptsTable)
      .values({
        factId: activeFactId,
        userId: kind === "studio" ? legendaryId : null,
        renderJobId: randomUUID(),
        requestId: kind === "single-review" ? `admin-review:${reviewId}:${legendaryId}:${randomUUID()}` : null,
        generationMode: "t2i",
        subjectRenderMode: "t2i_fallback",
        targetEngine: "nano_banana_2",
        sourceImageAnalysis: {} as never,
        identityPolicy: {} as never,
        renderControls: (kind === "single-review"
          ? { aspectRatio: "portrait", reviewAudit: { reviewId, adminUserId: legendaryId } }
          : { aspectRatio: "portrait" }) as never,
        factEnrichmentSnapshot: {} as never,
        renderedFactText: "x.",
        archetypeStrategyVersion: "v2",
        reviewId: kind === "scenario" ? reviewId : null,
        evalRunId: kind === "eval" ? evalRunId : null,
      })
      .returning({ id: imagePromptAttemptsTable.id });
    return row!.id;
  }

  async function seedJob(label: string, queue: string, attemptId: number, status: string): Promise<void> {
    const [row] = await db
      .insert(asyncJobsTable)
      .values({ queue, payload: { attemptId } as never, status, maxAttempts: 3 })
      .returning({ id: asyncJobsTable.id });
    jobs[label] = row!.id;
    jobIds.push(row!.id);
  }

  async function statusOf(label: string): Promise<{ status: string; lastError: string | null }> {
    const [row] = await db
      .select({ status: asyncJobsTable.status, lastError: asyncJobsTable.lastError })
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.id, jobs[label]!));
    return row!;
  }

  before(async () => {
    const [review] = await db
      .insert(pendingReviewsTable)
      .values({
        submittedText: "{NAME} outran a sunrise.",
        submittedById: legendaryId,
        matchingSimilarity: 0,
        status: "pending",
        workflowStage: "production_review" as never,
        stagingFactId: activeFactId,
      })
      .returning({ id: pendingReviewsTable.id });
    const [run] = await db.insert(evalRunsTable).values({ label: `${USER_PREFIX}run` }).returning({ id: evalRunsTable.id });
    for (const kind of ["studio", "scenario", "single-review", "eval"] as Kind[]) {
      attempts.set(kind, await seedAttempt(kind, review!.id, run!.id));
    }
    await seedJob("studio-pending", "image_prompt_generation", attempts.get("studio")!, "pending");
    await seedJob("studio-processing", "image_generation", attempts.get("studio")!, "processing");
    await seedJob("studio-done", "image_generation", attempts.get("studio")!, "done");
    await seedJob("scenario-pending", "image_prompt_generation", attempts.get("scenario")!, "pending");
    await seedJob("single-review-processing", "image_generation", attempts.get("single-review")!, "processing");
    await seedJob("eval-pending", "image_prompt_generation", attempts.get("eval")!, "pending");
    await db.execute(sql.raw(MIGRATION_SQL));
  });

  it("retires the studio's pending and in-flight jobs as terminal, with the reason", async () => {
    for (const label of ["studio-pending", "studio-processing"]) {
      const row = await statusOf(label);
      assert.equal(row.status, "failed", label);
      assert.match(String(row.lastError), /legacy meme studio was removed/, label);
    }
  });

  it("leaves a finished studio job, and moderation, single-review and eval jobs, untouched", async () => {
    assert.equal((await statusOf("studio-done")).status, "done");
    assert.equal((await statusOf("scenario-pending")).status, "pending");
    assert.equal((await statusOf("single-review-processing")).status, "processing");
    assert.equal((await statusOf("eval-pending")).status, "pending");
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before2 = await Promise.all(Object.keys(jobs).map(async (l) => [l, (await statusOf(l)).status] as const));
    await db.execute(sql.raw(MIGRATION_SQL));
    const after2 = await Promise.all(Object.keys(jobs).map(async (l) => [l, (await statusOf(l)).status] as const));
    assert.deepEqual(after2, before2);
  });

  it("leaves the attempt rows themselves in place (eval rating data)", async () => {
    const ids = [...attempts.values()];
    const rows = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.id, ids));
    assert.equal(rows.length, ids.length);
  });
});
