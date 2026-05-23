/**
 * Integration tests for routes/adminEngines.ts.
 *
 * Mounts adminEnginesRouter behind the shared buildTestApp() stub auth so we
 * exercise the real requireAdmin gate end-to-end.
 *
 * Touches the real test DB. Inserts engine rows under the `t-ae-` prefix
 * (cleanup deletes only rows with that prefix). Uses the wizard's
 * `paramSchema` shape mirroring migration 0057, so buildEngineInput accepts
 * the test inputs cleanly during the synthetic-test endpoint.
 *
 * The synthetic test endpoint NEVER calls real fal — it goes through the
 * `__setFalSubscribeForTest` / `__setFalUploadForTest` hooks.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, enginesTable } from "@workspace/db/schema";
import { eq, like, inArray } from "drizzle-orm";

import adminEnginesRouter, {
  __setFalUploadForTest,
  __setFalSubmitForTest,
  __setFalPollForTest,
} from "../routes/adminEngines.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { clearEngineCaches } from "../lib/engineInterpreter.js";
import { ADMIN_EDITABLE_FIELDS } from "../lib/engines/types.js";

const ENGINE_PREFIX = "t-ae-";
const USER_PREFIX = "t-ae-u-";

const insertedUserIds: string[] = [];
const insertedEngineIds: string[] = [];

async function createTestUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: opts.isAdmin ? "legendary" : "registered",
    isAdmin: !!opts.isAdmin,
  });
  insertedUserIds.push(id);
  return id;
}

interface SeedOpts {
  id?: string;
  kind?: "image" | "video" | "utility";
  isDefault?: boolean;
  isActive?: boolean;
  featureFlagRequired?: string | null;
  paramSchema?: unknown;
}

async function seedEngine(opts: SeedOpts = {}): Promise<string> {
  const id = opts.id ?? `${ENGINE_PREFIX}${randomUUID().slice(0, 12)}`;
  await db.insert(enginesTable).values({
    id,
    provider: "fal",
    endpointId: `fal-ai/test/${id}`,
    label: `Test engine ${id}`,
    description: "Synthetic test engine — created by adminEngines.test.ts.",
    kind: opts.kind ?? "video",
    tierRequirement: "legendary",
    isDefault: opts.isDefault ?? false,
    isActive: opts.isActive ?? true,
    sortOrder: 999,
    allowedDurationsSec: [4, 6, 8],
    defaultDurationSec: 6,
    allowedResolutions: ["720p"],
    defaultResolution: "720p",
    allowedAspectRatios: ["16:9", "1:1", "9:16"],
    defaultAspectRatio: "16:9",
    supportedModes: [],
    defaultMode: null,
    audioHandling: "none",
    paramSchema: (opts.paramSchema ?? {
      params: [
        { name: "image_url", from: "imageUrl", type: "string", required: true },
        { name: "prompt", from: "motionPrompt", type: "string", required: true },
        { name: "duration", from: "durationSec", type: "int", default: 6 },
      ],
    }) as unknown,
    estimatedCostUsdPerCall: null,
    estimatedCostUsdPerSecond: "0.05",
    expectedRunMs: 18000,
    featureFlagRequired: opts.featureFlagRequired ?? null,
  });
  insertedEngineIds.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  if (insertedEngineIds.length > 0) {
    await db.delete(enginesTable).where(inArray(enginesTable.id, insertedEngineIds));
    insertedEngineIds.length = 0;
  }
  // Catch-all in case earlier runs leaked.
  await db.delete(enginesTable).where(like(enginesTable.id, `${ENGINE_PREFIX}%`));
  if (insertedUserIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
    insertedUserIds.length = 0;
  }
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));

  // Our set-default test flips isDefault on every same-kind engine — including
  // the production seed rows. Restore the canonical migration-0057 defaults so
  // sibling test files (videoJobs.test.ts, etc.) keep finding a default video
  // engine after this file runs.
  await db
    .update(enginesTable)
    .set({ isDefault: true })
    .where(eq(enginesTable.id, "veo-3.1-lite"));
  await db
    .update(enginesTable)
    .set({ isDefault: true })
    .where(eq(enginesTable.id, "pulid-flux"));
  await db
    .update(enginesTable)
    .set({ isDefault: true })
    .where(eq(enginesTable.id, "fal-auto-subtitle"));
  clearEngineCaches();
}

let adminUserId: string;
let plainUserId: string;

// Ensure the falClient boot gate doesn't reject the synthetic POST /test
// path: ensureFalConfigured() (added to centralize fal credential lookup)
// throws when neither env var is set. We override fal.subscribe and
// fal.storage.upload via test hooks anyway, so the credential value is
// irrelevant — but a non-empty value is required to clear the gate.
const FAL_KEY_RESTORE = process.env["FAL_AI_API_KEY"];
process.env["FAL_AI_API_KEY"] = process.env["FAL_AI_API_KEY"] ?? "test-fal-key";

before(async () => {
  await cleanup();
  adminUserId = await createTestUser({ isAdmin: true });
  plainUserId = await createTestUser({ isAdmin: false });
});

after(async () => {
  if (FAL_KEY_RESTORE === undefined) {
    delete process.env["FAL_AI_API_KEY"];
  } else {
    process.env["FAL_AI_API_KEY"] = FAL_KEY_RESTORE;
  }
  await cleanup();
});

beforeEach(() => {
  clearEngineCaches();
});

afterEach(() => {
  __setFalUploadForTest(null);
  __setFalSubmitForTest(null);
  __setFalPollForTest(null);
});

// ─── Auth gate matrix ─────────────────────────────────────────────────────────

describe("admin engines — auth gate", () => {
  it("GET returns 401 with no credentials", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminEnginesRouter);
    const res = await request(app).get("/api/admin/engines");
    assert.equal(res.status, 401);
  });

  it("GET returns 403 admin_required for a non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: plainUserId }, adminEnginesRouter);
    const res = await request(app).get("/api/admin/engines");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin_required");
  });

  it("PATCH returns 401 with no credentials", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminEnginesRouter);
    const res = await request(app).patch("/api/admin/engines/any").send({ isActive: true });
    assert.equal(res.status, 401);
  });

  it("PATCH returns 403 for a non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: plainUserId }, adminEnginesRouter);
    const res = await request(app).patch("/api/admin/engines/any").send({ isActive: true });
    assert.equal(res.status, 403);
  });

  it("DELETE returns 401 with no credentials", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminEnginesRouter);
    const res = await request(app).delete("/api/admin/engines/any");
    assert.equal(res.status, 401);
  });

  it("DELETE returns 403 for a non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: plainUserId }, adminEnginesRouter);
    const res = await request(app).delete("/api/admin/engines/any");
    assert.equal(res.status, 403);
  });

  it("POST /test returns 401 with no credentials", async () => {
    const app = buildTestApp({ kind: "unauthenticated" }, adminEnginesRouter);
    const res = await request(app).post("/api/admin/engines/any/test").send({});
    assert.equal(res.status, 401);
  });

  it("POST /test returns 403 for a non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: plainUserId }, adminEnginesRouter);
    const res = await request(app).post("/api/admin/engines/any/test").send({});
    assert.equal(res.status, 403);
  });

  it("POST /set-default returns 403 for a non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: plainUserId }, adminEnginesRouter);
    const res = await request(app).post("/api/admin/engines/any/set-default").send({});
    assert.equal(res.status, 403);
  });

  it("POST /restore returns 403 for a non-admin", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: plainUserId }, adminEnginesRouter);
    const res = await request(app).post("/api/admin/engines/any/restore").send({});
    assert.equal(res.status, 403);
  });
});

// ─── GET /admin/engines ───────────────────────────────────────────────────────

describe("GET /admin/engines", () => {
  it("returns all engines (including soft-deleted) for admin", async () => {
    const liveId = await seedEngine();
    const archivedId = await seedEngine();
    // Manually soft-delete the second one so the GET handler must include it.
    await db.update(enginesTable).set({ deletedAt: new Date() }).where(eq(enginesTable.id, archivedId));

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get("/api/admin/engines");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.engines));
    assert.ok(Array.isArray(res.body.editableFields));
    const ids = (res.body.engines as Array<{ id: string }>).map((e) => e.id);
    assert.ok(ids.includes(liveId), "GET should include live engine");
    assert.ok(ids.includes(archivedId), "GET should include soft-deleted engine");

    // editableFields contract: matches the exported ADMIN_EDITABLE_FIELDS
    assert.deepEqual(res.body.editableFields, [...ADMIN_EDITABLE_FIELDS]);
  });
});

// ─── PATCH /admin/engines/:id ─────────────────────────────────────────────────

describe("PATCH /admin/engines/:id", () => {
  it("persists an allowed field and reflects it on subsequent GET", async () => {
    const id = await seedEngine({ isActive: true });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);

    const patchRes = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ isActive: false });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.isActive, false);

    const getRes = await request(app).get("/api/admin/engines");
    assert.equal(getRes.status, 200);
    const row = (getRes.body.engines as Array<{ id: string; isActive: boolean }>).find((e) => e.id === id);
    assert.ok(row);
    assert.equal(row.isActive, false);
  });

  it("rejects a disallowed field (paramSchema) with 400", async () => {
    const id = await seedEngine();
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ paramSchema: { params: [] } });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /paramSchema/);
  });

  it("rejects a disallowed field (endpointId) with 400", async () => {
    const id = await seedEngine();
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ endpointId: "fal-ai/some-other" });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /endpointId/);
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${ENGINE_PREFIX}does-not-exist`)
      .send({ isActive: false });
    assert.equal(res.status, 404);
  });

  it("validates expectedRunMs is non-negative", async () => {
    const id = await seedEngine();
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ expectedRunMs: -1 });
    assert.equal(res.status, 400);
  });

  it("allows featureFlagRequired to be set to null", async () => {
    const id = await seedEngine({ featureFlagRequired: "experiments" });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ featureFlagRequired: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.featureFlagRequired, null);
  });
});

// ─── DELETE + POST /restore ───────────────────────────────────────────────────

describe("DELETE /admin/engines/:id + restore", () => {
  it("soft-deletes (sets deletedAt) and keeps the row queryable via GET", async () => {
    const id = await seedEngine();
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);

    const delRes = await request(app).delete(`/api/admin/engines/${id}`);
    assert.equal(delRes.status, 200);
    assert.ok(delRes.body.deletedAt, "deletedAt should be set");

    const getRes = await request(app).get("/api/admin/engines");
    const row = (getRes.body.engines as Array<{ id: string; deletedAt: string | null }>).find((e) => e.id === id);
    assert.ok(row, "row should still appear in the admin GET");
    assert.ok(row.deletedAt, "deletedAt should be present");
  });

  it("POST /restore clears deletedAt", async () => {
    const id = await seedEngine();
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);

    await request(app).delete(`/api/admin/engines/${id}`);
    const res = await request(app).post(`/api/admin/engines/${id}/restore`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.deletedAt, null);
  });

  it("DELETE 404s for an unknown id", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).delete(`/api/admin/engines/${ENGINE_PREFIX}nope`);
    assert.equal(res.status, 404);
  });
});

// ─── POST /:id/set-default ────────────────────────────────────────────────────

describe("POST /admin/engines/:id/set-default", () => {
  it("flips isDefault on the target and unsets it on every other engine of the same kind", async () => {
    const oldDefault = await seedEngine({ kind: "video", isDefault: true });
    const newDefault = await seedEngine({ kind: "video", isDefault: false });
    // A different-kind engine should be unaffected.
    const imageEngine = await seedEngine({ kind: "image", isDefault: true });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${newDefault}/set-default`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.isDefault, true);

    // Re-fetch all and verify
    const getRes = await request(app).get("/api/admin/engines");
    const rows = getRes.body.engines as Array<{ id: string; isDefault: boolean; kind: string }>;
    const old = rows.find((e) => e.id === oldDefault);
    const fresh = rows.find((e) => e.id === newDefault);
    const img = rows.find((e) => e.id === imageEngine);

    assert.ok(old && fresh && img);
    assert.equal(old.isDefault, false, "old default should be cleared");
    assert.equal(fresh.isDefault, true, "new default should be set");
    assert.equal(img.isDefault, true, "image-kind engine should be untouched");
  });

  it("404s for an unknown engine", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${ENGINE_PREFIX}nope/set-default`).send({});
    assert.equal(res.status, 404);
  });
});

// ─── POST /:id/test (synthetic generation) ────────────────────────────────────

describe("POST /admin/engines/:id/test", () => {
  it("happy path: builds a fal input matching the engine paramSchema and returns 202 with requestId", async () => {
    const id = await seedEngine();
    let capturedEndpoint = "";
    let capturedInput: Record<string, unknown> | null = null;

    __setFalUploadForTest(async () => "https://fal.cdn.test/test-face.jpg");
    __setFalSubmitForTest(async (endpoint, opts) => {
      capturedEndpoint = endpoint;
      capturedInput = opts.input;
      return { request_id: "test-req-1" };
    });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${id}/test`).send({});
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "submitted");
    assert.equal(res.body.requestId, "test-req-1");
    assert.equal(capturedEndpoint, `fal-ai/test/${id}`);
    assert.ok(capturedInput, "fal.queue.submit input should have been captured");
    assert.equal((capturedInput as Record<string, unknown>).image_url, "https://fal.cdn.test/test-face.jpg");
    assert.ok((capturedInput as Record<string, unknown>).prompt);
    assert.equal((capturedInput as Record<string, unknown>).duration, 6);

    // Response exposes falInput immediately so the admin can verify the payload shape.
    assert.deepEqual(res.body.falInput, capturedInput);
    assert.ok(res.body.testFixtures);
  });

  it("captures error body cleanly when fal.queue.submit throws", async () => {
    const id = await seedEngine();
    __setFalUploadForTest(async () => "https://fal.cdn.test/test-face.jpg");
    __setFalSubmitForTest(async () => {
      const err = new Error("fal.queue.submit blew up") as Error & { body?: unknown; status?: number };
      err.body = { detail: [{ msg: "invalid input" }] };
      err.status = 422;
      throw err;
    });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${id}/test`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.falInput, "falInput should still be returned on submit failure");
    assert.match(String(res.body.error.message), /blew up/);
    assert.equal(res.body.error.status, 422);
    assert.deepEqual(res.body.error.body, { detail: [{ msg: "invalid input" }] });
  });

  it("rejects utility engines without a sampleImageUrl with a clear message", async () => {
    const id = await seedEngine({
      kind: "utility",
      paramSchema: {
        params: [{ name: "video_url", from: "videoUrl", type: "string", required: true }],
      },
    });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${id}/test`).send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "test_not_supported");
  });

  it("uses an admin-supplied sampleImageUrl when present (no upload call)", async () => {
    const id = await seedEngine();
    let uploadCalled = false;
    let capturedInput: Record<string, unknown> | null = null;
    __setFalUploadForTest(async () => { uploadCalled = true; return "should-not-be-used"; });
    __setFalSubmitForTest(async (_endpoint, opts) => {
      capturedInput = opts.input;
      return { request_id: "x" };
    });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .post(`/api/admin/engines/${id}/test`)
      .send({ sampleImageUrl: "https://example.com/admin-supplied.jpg" });
    assert.equal(res.status, 202);
    assert.equal(uploadCalled, false, "upload should be skipped when sampleImageUrl is supplied");
    const ci = capturedInput as unknown as Record<string, unknown> | null;
    assert.equal(ci?.image_url, "https://example.com/admin-supplied.jpg");
  });

  it("404s for an unknown engine", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${ENGINE_PREFIX}nope/test`).send({});
    assert.equal(res.status, 404);
  });
});

// ─── GET /:id/test/poll/:requestId ────────────────────────────────────────────

describe("GET /admin/engines/:id/test/poll/:requestId", () => {
  it("returns done:true ok:true with falResult when poll override signals completion", async () => {
    const id = await seedEngine();
    __setFalPollForTest(async (_endpoint, requestId) => ({
      done: true,
      ok: true,
      falResult: { data: { video: { url: "https://fal.cdn.test/out.mp4" } }, requestId },
      durationMs: 12345,
    }));

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get(`/api/admin/engines/${id}/test/poll/test-req-1`);
    assert.equal(res.status, 200);
    assert.equal(res.body.done, true);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.falResult);
  });

  it("returns done:false with phase when poll override signals in-queue", async () => {
    const id = await seedEngine();
    __setFalPollForTest(async () => ({
      done: false,
      phase: "IN_QUEUE",
      queuePosition: 3,
    }));

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get(`/api/admin/engines/${id}/test/poll/test-req-2`);
    assert.equal(res.status, 200);
    assert.equal(res.body.done, false);
    assert.equal(res.body.phase, "IN_QUEUE");
    assert.equal(res.body.queuePosition, 3);
  });

  it("returns done:true ok:false when poll override throws", async () => {
    const id = await seedEngine();
    __setFalPollForTest(async () => {
      throw new Error("poll network error");
    });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get(`/api/admin/engines/${id}/test/poll/test-req-3`);
    assert.equal(res.status, 200);
    assert.equal(res.body.done, true);
    assert.equal(res.body.ok, false);
    assert.match(String(res.body.error.message), /poll network error/);
  });

  it("404s for an unknown engine", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get(`/api/admin/engines/${ENGINE_PREFIX}nope/test/poll/any-req-id`);
    assert.equal(res.status, 404);
  });
});
