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
import {
  usersTable,
  enginesTable,
  factsTable,
  lookStylesTable,
  motionPresetsTable,
} from "@workspace/db/schema";
import { eq, like, inArray } from "drizzle-orm";

import adminEnginesRouter, {
  __setFalUploadForTest,
  __setFalSubmitForTest,
  __setFalPollForTest,
  __resetSubmitTimestampsForTest,
  __setPlanGeneratorForTest,
  __setSourceImageAnalyzerForTest,
  __setVideoStylePromptGeneratorForTest,
  __resetBundledFaceUrlForTest,
  engineBenchType,
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
  kind?: "image" | "video" | "utility" | "llm";
  provider?: string;
  endpointId?: string;
  isDefault?: boolean;
  isActive?: boolean;
  featureFlagRequired?: string | null;
  paramSchema?: unknown;
}

async function seedEngine(opts: SeedOpts = {}): Promise<string> {
  const id = opts.id ?? `${ENGINE_PREFIX}${randomUUID().slice(0, 12)}`;
  await db.insert(enginesTable).values({
    id,
    provider: opts.provider ?? "fal",
    endpointId: opts.endpointId ?? `fal-ai/test/${id}`,
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
  __resetSubmitTimestampsForTest();
});

afterEach(() => {
  __setFalUploadForTest(null);
  __setFalSubmitForTest(null);
  __setFalPollForTest(null);
  __setVideoStylePromptGeneratorForTest(null);
  __resetBundledFaceUrlForTest();
  __resetSubmitTimestampsForTest();
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

  it("rejects endpointId edits on a non-OpenAI engine", async () => {
    const id = await seedEngine({ provider: "fal" });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ endpointId: "gpt-4o" });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /only editable for OpenAI/i);
  });

  it("edits the model + sampling + reasoning on an OpenAI llm engine", async () => {
    const id = await seedEngine({ provider: "openai", kind: "llm", endpointId: "gpt-4o-mini" });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ endpointId: "gpt-5.2", defaultTemperature: 0.3, defaultMaxTokens: 800, defaultReasoningEffort: "medium" });
    assert.equal(res.status, 200);
    assert.equal(res.body.endpointId, "gpt-5.2");
    assert.equal(Number(res.body.defaultTemperature), 0.3);
    assert.equal(res.body.defaultMaxTokens, 800);
    assert.equal(res.body.defaultReasoningEffort, "medium");
  });

  it("rejects an unknown model for an OpenAI llm engine", async () => {
    const id = await seedEngine({ provider: "openai", kind: "llm", endpointId: "gpt-4o-mini" });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .patch(`/api/admin/engines/${id}`)
      .send({ endpointId: "gpt-9-imaginary" });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /endpointId must be one of/i);
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

  it("dryRun: returns the built falInput without uploading or submitting", async () => {
    const id = await seedEngine();
    let uploadCalled = false;
    let submitCalled = false;
    __setFalUploadForTest(async () => { uploadCalled = true; return "should-not-upload"; });
    __setFalSubmitForTest(async () => { submitCalled = true; return { request_id: "should-not-submit" }; });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${id}/test`).send({ dryRun: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.endpointId, `fal-ai/test/${id}`);
    assert.ok(res.body.falInput, "falInput should be returned for a dry run");
    assert.ok((res.body.falInput as Record<string, unknown>).prompt);
    assert.equal(uploadCalled, false, "dry run must not upload to fal.storage");
    assert.equal(submitCalled, false, "dry run must not submit to the fal queue");
  });

  it("captures error body cleanly when fal.queue.submit throws (502 Bad Gateway)", async () => {
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
    // 502 — the failure originated at fal; the body still carries falInput
    // and a structured error so the workbench can render it like any other
    // ok:false outcome.
    assert.equal(res.status, 502);
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

  // ─── Per-kind benches ───────────────────────────────────────────────────
  const T2I_SCHEMA = {
    params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      {
        name: "image_size",
        from: "aspectRatio",
        type: "string",
        map: { landscape: "landscape_16_9", square: "square_hd", portrait: "portrait_16_9" },
        default: "square_hd",
      },
    ],
  };
  const I2I_SCHEMA = {
    params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ],
  };

  it("text-to-image bench: no source upload, sends the prompt, no image input", async () => {
    const id = await seedEngine({ kind: "image", paramSchema: T2I_SCHEMA });
    let uploadCalled = false;
    let capturedInput: Record<string, unknown> | null = null;
    __setFalUploadForTest(async () => { uploadCalled = true; return "nope"; });
    __setFalSubmitForTest(async (_e, opts) => { capturedInput = opts.input; return { request_id: "t2i" }; });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .post(`/api/admin/engines/${id}/test`)
      .send({ imagePrompt: "a neon cyberpunk skyline at dusk" });

    assert.equal(res.status, 202);
    assert.equal(res.body.benchType, "text-to-image");
    assert.equal(uploadCalled, false, "text-to-image must not upload a source image");
    const ci = capturedInput as unknown as Record<string, unknown> | null;
    assert.equal(ci?.prompt, "a neon cyberpunk skyline at dusk");
    assert.equal(ci?.image_url, undefined, "no source image input for text-to-image");
    assert.equal(ci?.image_urls, undefined);
  });

  it("image-to-image bench: uploads a source and sends prompt + reference", async () => {
    const id = await seedEngine({ kind: "image", paramSchema: I2I_SCHEMA });
    let uploadCalled = false;
    let capturedInput: Record<string, unknown> | null = null;
    __setFalUploadForTest(async () => { uploadCalled = true; return "https://fal.cdn.test/face.jpg"; });
    __setFalSubmitForTest(async (_e, opts) => { capturedInput = opts.input; return { request_id: "i2i" }; });

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .post(`/api/admin/engines/${id}/test`)
      .send({ imagePrompt: "turn them into a renaissance oil painting" });

    assert.equal(res.status, 202);
    assert.equal(res.body.benchType, "image-to-image");
    assert.equal(uploadCalled, true, "image-to-image uploads the test face when no sample given");
    const ci = capturedInput as unknown as Record<string, unknown> | null;
    assert.equal(ci?.prompt, "turn them into a renaissance oil painting");
    assert.deepEqual(ci?.image_urls, ["https://fal.cdn.test/face.jpg"]);
  });
});

describe("engineBenchType", () => {
  const base = { kind: "image" as const };
  it("classifies video and utility by kind", () => {
    assert.equal(engineBenchType({ kind: "video" }), "video");
    assert.equal(engineBenchType({ kind: "utility" }), "utility");
  });
  it("classifies image engines by whether they declare a source image", () => {
    assert.equal(
      engineBenchType({ ...base, paramSchema: { params: [{ name: "image_urls", from: "referenceImageUrl" }] } }),
      "image-to-image",
    );
    assert.equal(
      engineBenchType({ ...base, paramSchema: { params: [{ name: "image_url", from: "imageUrl" }] } }),
      "image-to-image",
    );
    assert.equal(
      engineBenchType({ ...base, paramSchema: { params: [{ name: "prompt", from: "imagePrompt" }] } }),
      "text-to-image",
    );
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

  it("computes durationMs from the submit timestamp when the override omits it", async () => {
    const id = await seedEngine();

    // Submit first so the timestamp lands in the map under a real requestId.
    __setFalUploadForTest(async () => "https://fal.cdn.test/test-face.jpg");
    __setFalSubmitForTest(async () => ({ request_id: "req-with-duration" }));
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const submitRes = await request(app).post(`/api/admin/engines/${id}/test`).send({});
    assert.equal(submitRes.status, 202);

    // Sleep a tick so the elapsed window is > 0.
    await new Promise((r) => setTimeout(r, 20));

    __setFalPollForTest(async () => ({
      done: true,
      ok: true,
      falResult: { data: { video: { url: "https://fal.cdn.test/out.mp4" } } },
      // No durationMs here — the route should fill it in from the map.
    }));
    const pollRes = await request(app).get(`/api/admin/engines/${id}/test/poll/req-with-duration`);
    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.body.done, true);
    assert.equal(pollRes.body.ok, true);
    assert.ok(
      typeof pollRes.body.durationMs === "number" && pollRes.body.durationMs >= 15,
      `durationMs should reflect submit→done window, got ${pollRes.body.durationMs}`,
    );
  });

  it("preserves an explicit durationMs from the poll override", async () => {
    const id = await seedEngine();
    __setFalPollForTest(async () => ({
      done: true,
      ok: true,
      falResult: { data: {} },
      durationMs: 99999,
    }));
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get(`/api/admin/engines/${id}/test/poll/req-explicit`);
    assert.equal(res.body.durationMs, 99999);
  });

  it("treats a done override as terminal and evicts the submit timestamp", async () => {
    const id = await seedEngine();

    __setFalUploadForTest(async () => "https://fal.cdn.test/test-face.jpg");
    __setFalSubmitForTest(async () => ({ request_id: "req-evict" }));
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    await request(app).post(`/api/admin/engines/${id}/test`).send({});

    // First poll completes successfully → submit timestamp is deleted.
    __setFalPollForTest(async () => ({ done: true, ok: true, falResult: {} }));
    const first = await request(app).get(`/api/admin/engines/${id}/test/poll/req-evict`);
    assert.equal(first.body.ok, true);
    assert.ok(
      typeof first.body.durationMs === "number",
      "first terminal poll should still have durationMs from the map",
    );

    // Second poll on the same requestId should no longer have a stashed
    // timestamp — durationMs comes back undefined.
    __setFalPollForTest(async () => ({ done: true, ok: true, falResult: {} }));
    const second = await request(app).get(`/api/admin/engines/${id}/test/poll/req-evict`);
    assert.equal(second.body.durationMs, undefined);
  });

  // ── New: fal terminal-failure handling (FAILED / CANCELED) ──────────────
  //
  // Before this branch existed, the workbench polled forever on a failed
  // job. The real fal client returns status === "FAILED" or "CANCELED";
  // we exercise the override surface here since the real client is
  // bypassed by falPollOverride.

  it("treats override-reported FAILED as terminal", async () => {
    const id = await seedEngine();
    __setFalPollForTest(async () => ({
      done: true,
      ok: false,
      error: { message: "fal job failed", status: "FAILED" },
    }));
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).get(`/api/admin/engines/${id}/test/poll/req-failed`);
    assert.equal(res.body.done, true);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.status, "FAILED");
  });
});

// ─── POST /:id/assemble-prompt (production-accurate test prompts) ──────────────
describe("POST /admin/engines/:id/assemble-prompt", () => {
  const SCENE = { fact_type: "action" as const, male: "Cinematic man scene", female: "Cinematic woman scene", neutral: "Cinematic neutral scene" };

  async function seedFact(scenePrompts: unknown | null): Promise<number> {
    const [row] = await db
      .insert(factsTable)
      .values({ text: `t-ae assemble fact ${randomUUID().slice(0, 8)}`, isActive: true, aiScenePrompts: scenePrompts as never })
      .returning({ id: factsTable.id });
    return row!.id;
  }
  async function seedMotionPreset(): Promise<string> {
    const id = `t-ae-mp-${randomUUID().slice(0, 8)}`;
    await db.insert(motionPresetsTable).values({ id, label: "Test motion", motionPrompt: "slow dolly push-in" });
    return id;
  }

  // Image benches now run the render-time prompt engine, which REQUIRES valid
  // fact enrichment. Seed a minimal-valid enrichment; the plan generator is
  // stubbed so no test hits OpenAI (the real Nano Banana compiler still runs).
  const VALID_ENRICHMENT = {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: ["single_subject_focus"],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["legendary", "strength", "feat"],
    taxonomyConfidence: 0.95,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
  };

  async function seedEnrichedFact(enrichment: unknown = VALID_ENRICHMENT): Promise<number> {
    const [row] = await db
      .insert(factsTable)
      .values({ text: `t-ae assemble fact ${randomUUID().slice(0, 8)}`, isActive: true, enrichment: enrichment as never })
      .returning({ id: factsTable.id });
    return row!.id;
  }

  // A full ImagePromptGenerationOutput the stubbed generator returns; the route
  // feeds visualPlan/compiledPrompt into the real Nano Banana 2 compiler.
  function makeStubPlan(mode: "human_identity_i2i" | "t2i_fallback", promptText: string) {
    const generationMode = mode === "t2i_fallback" ? ("t2i" as const) : ("i2i" as const);
    return {
      visualPlan: {
        sceneConcept: "A superhuman feat",
        visualGoal: "Make the feat legible",
        visualApproach: "Cinematic close-up",
        archetypeApplication: {
          primaryArchetype: "superhuman_physical_feat",
          subtype: "force_scaled_action",
          selectedFrame: "direct_action",
          strategyRationale: "Authored strategy applies.",
        },
        coreScene: "The protagonist performs a superhuman feat in the foreground.",
        subjectDetails: ["confident focused expression", "mid-exertion heroic pose"],
        environment: ["dramatic stage lighting", "blurred arena background"],
        lightingAndStyle: "high-contrast cinematic key light",
        keyVisualElements: ["central subject", "dramatic lighting", "exertion pose"],
        subjectTreatment: {
          roleInScene: "Protagonist",
          subjectRenderMode: mode,
          identityPreservation: mode === "human_identity_i2i" ? "human_face" : "none",
          nonhumanSubjectTreatment: {
            applicable: false,
            subjectKind: "not_applicable",
            preserveTraits: [],
            anthropomorphicTreatment: "none",
            doNotTransformIntoHuman: false,
          },
          fallbackSubjectGender: mode === "t2i_fallback" ? "female" : "not_applicable",
          expressionAndPose: "Confident, focused",
          ageLifeStageTransform: { applies: false, targetState: "" },
        },
        subjectFactCompatibility: { rating: "strong", reason: "Stages well.", recommendedFallback: "none" },
        composition: {
          subjectFraming: "Medium close-up",
          negativeSpace: "top",
          cameraStyle: "Cinematic 35mm",
          sceneReadability: "Subject is the readable element",
        },
        supportingTextPolicy: {
          allowSupportingText: false,
          supportingTextElements: [],
          forbiddenTextTypes: [
            "full meme captions",
            "full fact text",
            "hashtags",
            "watermarks",
            "real logos",
            "brand marks",
            "long explanatory paragraphs",
          ],
        },
        secondaryCharacters: [],
        semanticEntitiesUsed: [],
        culturalReferencesUsed: [],
        styleIntegration: "Apply cinematic style",
        contentNotes: "SFW",
        debugNotes: "Strategy v2",
        targetEngine: "nano_banana_2" as const,
        generationMode,
      },
      compiledPrompt: { prompt: promptText, negativePrompt: "", engineNotes: "" },
      promptVersion: "test-prompt-v1",
      archetypeStrategyVersion: "test-strategy-v1",
      generatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      generatedBy: "openai" as const,
    };
  }

  const factIds: number[] = [];
  after(async () => {
    if (factIds.length) await db.delete(factsTable).where(inArray(factsTable.id, factIds));
    await db.delete(lookStylesTable).where(like(lookStylesTable.id, "t-ae-ls-%"));
    await db.delete(motionPresetsTable).where(like(motionPresetsTable.id, "t-ae-mp-%"));
  });

  it("text-to-image: runs the new engine → t2i_fallback with the bench gender + aspect ratio", async () => {
    const engineId = await seedEngine({ kind: "image", paramSchema: { params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
    ] } });
    const factId = await seedEnrichedFact(); factIds.push(factId);

    let seenInput: { subjectRenderMode?: string; renderControls?: Record<string, unknown> } | null = null;
    __setPlanGeneratorForTest(async (input) => {
      seenInput = input as never;
      return makeStubPlan("t2i_fallback", "A protagonist lifts a mountain.") as never;
    });
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, gender: "female", aspectRatio: "square" });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.benchType, "text-to-image");
      // The compiled Nano Banana prompt now carries the labeled visual contract
      // (coreScene + subjectDetails + environment from the structured visualPlan).
      assert.match(String(res.body.imagePrompt), /CORE SCENE:/);
      assert.match(String(res.body.imagePrompt), /The protagonist performs a superhuman feat/);
      // t2i → t2i_fallback, bench gender + aspect ratio flow into render controls.
      assert.equal(seenInput!.subjectRenderMode, "t2i_fallback");
      assert.equal(seenInput!.renderControls!["fallbackSubjectGender"], "female");
      assert.equal(seenInput!.renderControls!["aspectRatio"], "square");
    } finally {
      __setPlanGeneratorForTest(null);
    }
  });

  it("image-to-image: analyzes + renders against ONE resolved reference URL", async () => {
    const engineId = await seedEngine({ kind: "image", paramSchema: { params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ] } });
    const factId = await seedEnrichedFact(); factIds.push(factId);
    const SAMPLE = "https://img.test/face.jpg";

    let analyzedUrl: string | null = null;
    __setSourceImageAnalyzerForTest(async (ref) => {
      analyzedUrl = ref.imageUrl;
      const { noImageAnalysis } = await import("../lib/sourceImageAnalysis/index.js");
      return { ...noImageAnalysis(), hasUsableHumanFace: true, subjectKind: "human" } as never;
    });
    let seenInput: { subjectRenderMode?: string; referenceImageUrl?: string | null; renderControls?: Record<string, unknown> } | null = null;
    __setPlanGeneratorForTest(async (input) => {
      seenInput = input as never;
      return makeStubPlan("human_identity_i2i", "Restyle the person into a noir alley.") as never;
    });
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, gender: "neutral", sampleImageUrl: SAMPLE });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.benchType, "image-to-image");
      assert.equal(seenInput!.subjectRenderMode, "human_identity_i2i");
      // The SAME resolved URL is analyzed, fed to the generator, and put in renderControls.
      assert.equal(analyzedUrl, SAMPLE);
      assert.equal(seenInput!.referenceImageUrl, SAMPLE);
      assert.equal(seenInput!.renderControls!["referenceImageUrl"], SAMPLE);
    } finally {
      __setPlanGeneratorForTest(null);
      __setSourceImageAnalyzerForTest(null);
    }
  });

  it("image-to-image: 502 bundled_face_upload_failed when fal upload throws (no sampleImageUrl given)", async () => {
    const engineId = await seedEngine({ kind: "image", paramSchema: { params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
      { name: "image_urls", from: "referenceImageUrl", type: "stringArray", required: true },
    ] } });
    const factId = await seedEnrichedFact(); factIds.push(factId);
    __resetBundledFaceUrlForTest();
    __setFalUploadForTest(async () => { throw Object.assign(new Error("Forbidden"), { name: "ApiError", status: 403, body: { detail: "Exhausted balance." } }); });
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, gender: "neutral" }); // no sampleImageUrl → triggers bundled-face upload

      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.error, "bundled_face_upload_failed");
    } finally {
      __setFalUploadForTest(null);
      __resetBundledFaceUrlForTest();
    }
  });

  it("400 fact_enrichment_invalid when the fact has no usable enrichment", async () => {
    const engineId = await seedEngine({ kind: "image", paramSchema: { params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
    ] } });
    const factId = await seedEnrichedFact({ primaryArchetype: "nope" }); factIds.push(factId);

    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app)
      .post(`/api/admin/engines/${engineId}/assemble-prompt`)
      .send({ factId, gender: "neutral" });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, "fact_enrichment_invalid");
  });

  const SAMPLE_STILL = "https://img.test/still.jpg";

  it("video: empty motion prompt falls back to the motion preset alone", async () => {
    const engineId = await seedEngine({ kind: "video" });
    const factId = await seedFact(SCENE); factIds.push(factId);
    const motionPresetId = await seedMotionPreset();
    __setVideoStylePromptGeneratorForTest(async () => "");
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, motionPresetId, sampleImageUrl: SAMPLE_STILL });

      assert.equal(res.body.benchType, "video");
      assert.equal(res.body.motionPrompt, "slow dolly push-in");
      assert.equal(res.body.videoDirection, "");
      assert.match(res.body.dialogueText, /assemble fact/);
    } finally {
      __setVideoStylePromptGeneratorForTest(null);
    }
  });

  it("video: generates motion from the source image and merges it before the preset", async () => {
    const engineId = await seedEngine({ kind: "video" });
    const factId = await seedFact(SCENE); factIds.push(factId);
    const motionPresetId = await seedMotionPreset();
    let calls = 0;
    let seenImage: string | null | undefined;
    __setVideoStylePromptGeneratorForTest(async (_fact, imageUrl) => { calls += 1; seenImage = imageUrl; return "the bears strain to haul a sack up the pine"; });
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, motionPresetId, sampleImageUrl: SAMPLE_STILL });

      assert.equal(res.body.motionPrompt, "the bears strain to haul a sack up the pine slow dolly push-in");
      assert.equal(res.body.videoDirection, "the bears strain to haul a sack up the pine");
      assert.equal(calls, 1);
      // The source image is handed to the generator (vision input).
      assert.equal(seenImage, SAMPLE_STILL);
    } finally {
      __setVideoStylePromptGeneratorForTest(null);
    }
  });

  it("video: reuses a passed-in motion prompt; forceRegenerate re-rolls it", async () => {
    const engineId = await seedEngine({ kind: "video" });
    const factId = await seedFact(SCENE); factIds.push(factId);
    const motionPresetId = await seedMotionPreset();
    let calls = 0;
    __setVideoStylePromptGeneratorForTest(async () => { calls += 1; return `fresh-${calls}`; });
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);

      // Passing the current motion prompt back → reused verbatim, no generation.
      const reused = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, motionPresetId, sampleImageUrl: SAMPLE_STILL, videoDirection: "held motion" });
      assert.equal(reused.body.motionPrompt, "held motion slow dolly push-in");
      assert.equal(reused.body.videoDirection, "held motion");
      assert.equal(calls, 0);

      // forceRegenerate ignores the held value and generates a fresh one.
      const fresh = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, motionPresetId, sampleImageUrl: SAMPLE_STILL, videoDirection: "held motion", forceRegenerate: true });
      assert.equal(fresh.body.videoDirection, "fresh-1");
      assert.equal(fresh.body.motionPrompt, "fresh-1 slow dolly push-in");
      assert.equal(calls, 1);
    } finally {
      __setVideoStylePromptGeneratorForTest(null);
    }
  });

  it("video: falls back to the bundled test face when no sample image is given", async () => {
    const engineId = await seedEngine({ kind: "video" });
    const factId = await seedFact(SCENE); factIds.push(factId);
    const motionPresetId = await seedMotionPreset();
    __setFalUploadForTest(async () => "https://fal.cdn.test/bundled-face.jpg");
    let seenImage: string | null | undefined;
    __setVideoStylePromptGeneratorForTest(async (_fact, imageUrl) => { seenImage = imageUrl; return "subject lifts a finger"; });
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId, motionPresetId }); // no sampleImageUrl

      assert.equal(seenImage, "https://fal.cdn.test/bundled-face.jpg");
      assert.equal(res.body.videoDirection, "subject lifts a finger");
    } finally {
      __setVideoStylePromptGeneratorForTest(null);
      __setFalUploadForTest(null);
    }
  });

  it("video: renders fact tokens down to David Franklin / he-him in the dialogue", async () => {
    const engineId = await seedEngine({ kind: "video" });
    const [row] = await db
      .insert(factsTable)
      .values({
        text: "{NAME} pushes the Earth down when {SUBJ} does a {pushup|pushups}.",
        isActive: true,
        aiScenePrompts: SCENE as never,
      })
      .returning({ id: factsTable.id });
    factIds.push(row!.id);
    const motionPresetId = await seedMotionPreset();
    __setVideoStylePromptGeneratorForTest(async () => "");
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app)
        .post(`/api/admin/engines/${engineId}/assemble-prompt`)
        .send({ factId: row!.id, motionPresetId, sampleImageUrl: SAMPLE_STILL });

      assert.equal(res.body.dialogueText, "David Franklin pushes the Earth down when he does a pushup.");
    } finally {
      __setVideoStylePromptGeneratorForTest(null);
    }
  });

  it("image bench does NOT touch the legacy aiScenePrompts cache", async () => {
    const engineId = await seedEngine({ kind: "image", paramSchema: { params: [
      { name: "prompt", from: "imagePrompt", type: "string", required: true },
    ] } });
    const factId = await seedEnrichedFact(); factIds.push(factId);
    __setPlanGeneratorForTest(async () => makeStubPlan("t2i_fallback", "A neutral cosmic scene.") as never);
    try {
      const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
      const res = await request(app).post(`/api/admin/engines/${engineId}/assemble-prompt`).send({ factId, gender: "neutral" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      // The compiler now produces the labeled visual contract (CORE SCENE, etc.)
      // from the structured visualPlan, not the raw stub prompt text.
      assert.match(String(res.body.imagePrompt), /CORE SCENE:/);
      // The new engine must NOT write the legacy scene-prompt cache.
      const [row] = await db.select({ p: factsTable.aiScenePrompts }).from(factsTable).where(eq(factsTable.id, factId));
      assert.equal(row?.p ?? null, null, "the new engine must not write aiScenePrompts");
    } finally {
      __setPlanGeneratorForTest(null);
    }
  });

  it("400s when factId is missing", async () => {
    const engineId = await seedEngine({ kind: "image" });
    const app = buildTestApp({ kind: "authenticated", userId: adminUserId }, adminEnginesRouter);
    const res = await request(app).post(`/api/admin/engines/${engineId}/assemble-prompt`).send({});
    assert.equal(res.status, 400);
  });
});
