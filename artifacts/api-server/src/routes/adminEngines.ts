/**
 * Admin engines API.
 *
 * Sibling routes to `GET /api/engines` in routes/videos.ts (which serves the
 * wizard catalogue). These endpoints power the admin tooling at
 * /admin/engines and require `realUserRole === "admin"` via `requireAdmin`.
 *
 * The admin can:
 *   - list all engines, including soft-deleted (`GET /api/admin/engines`)
 *   - patch a whitelisted subset of editable fields (`PATCH …/:id`)
 *   - soft-delete an engine (`DELETE …/:id`) — clears wizard visibility but
 *     leaves the row so `video_jobs.video_engine_id` lineage keeps resolving
 *   - restore a soft-deleted engine (`POST …/:id/restore`)
 *   - swap the per-kind default in a single transaction
 *     (`POST …/:id/set-default`)
 *   - run a synthetic generation through fal to debug param shape
 *     (`POST …/:id/test`)
 *
 * `clearEngineCaches()` runs after every mutation so the interpreter's
 * 60s in-memory cache reflects the change within one request.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fal, ensureFalConfigured } from "../lib/falClient.js";

import { db } from "@workspace/db";
import { enginesTable, type Engine } from "@workspace/db/schema";
import { eq, ne, and } from "drizzle-orm";

import { requireAdmin } from "./admin.js";
import { clearEngineCaches, buildEngineInput } from "../lib/engineInterpreter.js";
import { applyAudioHandling } from "../lib/engineAudio.js";
import { ADMIN_EDITABLE_FIELDS } from "../lib/engines/types.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ────────────────────────────────────────────────────────────────────────────
// Admin-editable field allowlist
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fields the admin UI is allowed to PATCH. The allowlist is the single
 * source of truth from `lib/engines/types.ts:ADMIN_EDITABLE_FIELDS` so the
 * reconciler and PATCH handler can't drift apart.
 *
 * Code-owned fields (id, provider, endpointId, kind, audioHandling,
 * paramSchema, allowedDurationsSec, allowedResolutions, allowedAspectRatios,
 * supportedModes, label, description) are NOT in this list — they're either
 * primary keys, schema-shape concerns the interpreter relies on, or
 * marketing copy that ships in code/migrations.
 *
 * Numeric / nullable handling is enforced in the PATCH handler — this list
 * just gates the keyspace.
 */
// ADMIN_EDITABLE_FIELDS imported from lib/engines/types.ts (single source of
// truth so reconciler and PATCH allowlist stay in sync).
const ADMIN_EDITABLE_SET = new Set<string>(ADMIN_EDITABLE_FIELDS);

const VALID_TIERS = new Set(["unregistered", "registered", "legendary"]);

// ────────────────────────────────────────────────────────────────────────────
// Synthetic-test asset
// ────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * 1×1 placeholder JPEG shipped with the api-server. Used by the synthetic
 * test endpoint when no `sampleImageUrl` is supplied. The test is about
 * verifying the param shape fal expects — output quality is irrelevant.
 */
const TEST_FACE_ASSET = path.resolve(__dirname, "../assets/test-face.jpg");

/**
 * Override hook used by tests. When set, the test endpoint will call this
 * instead of `fal.subscribe` so the test never makes a real network call.
 * Production code paths never set this.
 */
type FalSubscribe = (
  endpoint: string,
  opts: { input: Record<string, unknown>; logs?: boolean },
) => Promise<{ requestId?: string | null; data?: unknown }>;
let falSubscribeOverride: FalSubscribe | null = null;

/** Test helper: replace the fal.subscribe wrapper used by POST /:id/test. */
export function __setFalSubscribeForTest(impl: FalSubscribe | null): void {
  falSubscribeOverride = impl;
}

type FalUpload = (blob: Blob) => Promise<string>;
let falUploadOverride: FalUpload | null = null;

/** Test helper: replace fal.storage.upload used by POST /:id/test. */
export function __setFalUploadForTest(impl: FalUpload | null): void {
  falUploadOverride = impl;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Validates and normalises a PATCH body. Returns either an updates object or an error message. */
function buildPatchUpdates(body: Record<string, unknown>): { updates: Record<string, unknown> } | { error: string } {
  // Reject any unknown keys up-front. updatedAt is set internally below; not
  // accepted from the body.
  for (const key of Object.keys(body)) {
    if (!ADMIN_EDITABLE_SET.has(key)) {
      return { error: `Field "${key}" is not admin-editable. Allowed: ${ADMIN_EDITABLE_FIELDS.join(", ")}.` };
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") return { error: "isActive must be a boolean" };
    updates.isActive = body.isActive;
  }
  if ("isDefault" in body) {
    if (typeof body.isDefault !== "boolean") return { error: "isDefault must be a boolean" };
    updates.isDefault = body.isDefault;
  }
  if ("sortOrder" in body) {
    if (typeof body.sortOrder !== "number" || !Number.isFinite(body.sortOrder)) {
      return { error: "sortOrder must be a finite number" };
    }
    updates.sortOrder = Math.trunc(body.sortOrder);
  }
  if ("tierRequirement" in body) {
    const v = String(body.tierRequirement ?? "");
    if (!VALID_TIERS.has(v)) {
      return { error: "tierRequirement must be one of unregistered | registered | legendary" };
    }
    updates.tierRequirement = v;
  }
  if ("featureFlagRequired" in body) {
    const v = body.featureFlagRequired;
    if (v === null || v === "" || v === undefined) {
      updates.featureFlagRequired = null;
    } else if (typeof v === "string") {
      updates.featureFlagRequired = v.trim() || null;
    } else {
      return { error: "featureFlagRequired must be a string or null" };
    }
  }
  if ("defaultDurationSec" in body) {
    const v = body.defaultDurationSec;
    if (v === null) updates.defaultDurationSec = null;
    else if (typeof v === "number" && Number.isFinite(v)) updates.defaultDurationSec = Math.trunc(v);
    else return { error: "defaultDurationSec must be a number or null" };
  }
  if ("defaultResolution" in body) {
    const v = body.defaultResolution;
    if (v === null || v === "") updates.defaultResolution = null;
    else if (typeof v === "string") updates.defaultResolution = v;
    else return { error: "defaultResolution must be a string or null" };
  }
  if ("defaultAspectRatio" in body) {
    const v = body.defaultAspectRatio;
    if (v === null || v === "") updates.defaultAspectRatio = null;
    else if (typeof v === "string") updates.defaultAspectRatio = v;
    else return { error: "defaultAspectRatio must be a string or null" };
  }
  if ("defaultMode" in body) {
    const v = body.defaultMode;
    if (v === null || v === "") updates.defaultMode = null;
    else if (typeof v === "string") updates.defaultMode = v;
    else return { error: "defaultMode must be a string or null" };
  }
  if ("expectedRunMs" in body) {
    if (typeof body.expectedRunMs !== "number" || !Number.isFinite(body.expectedRunMs) || body.expectedRunMs < 0) {
      return { error: "expectedRunMs must be a non-negative number" };
    }
    updates.expectedRunMs = Math.trunc(body.expectedRunMs);
  }
  if ("estimatedCostUsdPerCall" in body) {
    const v = body.estimatedCostUsdPerCall;
    if (v === null) updates.estimatedCostUsdPerCall = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0) updates.estimatedCostUsdPerCall = String(v);
    else return { error: "estimatedCostUsdPerCall must be a non-negative number or null" };
  }
  if ("estimatedCostUsdPerSecond" in body) {
    const v = body.estimatedCostUsdPerSecond;
    if (v === null) updates.estimatedCostUsdPerSecond = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0) updates.estimatedCostUsdPerSecond = String(v);
    else return { error: "estimatedCostUsdPerSecond must be a non-negative number or null" };
  }

  return { updates };
}

async function fetchEngineById(id: string): Promise<Engine | null> {
  const [row] = await db.select().from(enginesTable).where(eq(enginesTable.id, id)).limit(1);
  return row ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. GET /api/admin/engines
// ────────────────────────────────────────────────────────────────────────────

router.get("/admin/engines", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db.select().from(enginesTable);
  // Sort in JS so we don't need an index for the admin view; admin list is
  // small (<100 rows) so this is fine.
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id.localeCompare(b.id);
  });
  res.json({ engines: rows, editableFields: ADMIN_EDITABLE_FIELDS });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. PATCH /api/admin/engines/:id
// ────────────────────────────────────────────────────────────────────────────

router.patch("/admin/engines/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) {
    res.status(400).json({ error: "Engine id is required" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const result = buildPatchUpdates(body);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }

  const [updated] = await db
    .update(enginesTable)
    .set(result.updates)
    .where(eq(enginesTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Engine not found" });
    return;
  }
  clearEngineCaches();
  res.json(updated);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. DELETE /api/admin/engines/:id — soft delete
// ────────────────────────────────────────────────────────────────────────────

router.delete("/admin/engines/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const [updated] = await db
    .update(enginesTable)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(enginesTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Engine not found" });
    return;
  }
  clearEngineCaches();
  res.json(updated);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. POST /api/admin/engines/:id/restore
// ────────────────────────────────────────────────────────────────────────────

router.post("/admin/engines/:id/restore", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const [updated] = await db
    .update(enginesTable)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(enginesTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Engine not found" });
    return;
  }
  clearEngineCaches();
  res.json(updated);
});

// ────────────────────────────────────────────────────────────────────────────
// 5. POST /api/admin/engines/:id/set-default
// ────────────────────────────────────────────────────────────────────────────

router.post("/admin/engines/:id/set-default", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const target = await fetchEngineById(id);
  if (!target) {
    res.status(404).json({ error: "Engine not found" });
    return;
  }

  const { kind } = target;

  await db.transaction(async (tx) => {
    await tx
      .update(enginesTable)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(enginesTable.kind, kind), ne(enginesTable.id, id)));
    await tx
      .update(enginesTable)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(enginesTable.id, id));
  });

  clearEngineCaches();
  const updated = await fetchEngineById(id);
  res.json(updated);
});

// ────────────────────────────────────────────────────────────────────────────
// 6. POST /api/admin/engines/:id/test
// ────────────────────────────────────────────────────────────────────────────

interface TestBody {
  sampleImageUrl?: string;
}

/**
 * Synthetic generation through fal.subscribe — used by admins to verify
 * a new engine's param shape without burning a real user job.
 *
 * Body: { sampleImageUrl?: string }. When absent we upload the shipped
 * 1×1 test-face.jpg to fal.storage and use that. For utility engines like
 * auto-subtitle the "image" is actually a video URL — those reject with a
 * 400 unless the admin supplies an explicit URL.
 *
 * Returns:
 *   200 { ok: true, falInput, falResult, durationMs }
 *   200 { ok: false, falInput, error, durationMs }   (engine returned error)
 *   400 / 404 on validation problems
 */
router.post("/admin/engines/:id/test", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const engine = await fetchEngineById(id);
  if (!engine) {
    res.status(404).json({ error: "Engine not found" });
    return;
  }

  // Belt-and-suspenders — boot already calls ensureFalConfigured(), but
  // surfacing a clean 503 here means a missing key never leaks through as
  // a confusing 401 "Authorization header is required" from the fal SDK.
  try {
    ensureFalConfigured();
  } catch (err) {
    res.status(503).json({
      error: "fal_not_configured",
      message: err instanceof Error ? err.message : "fal.ai client is not configured",
    });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as TestBody;
  const provided = typeof body.sampleImageUrl === "string" ? body.sampleImageUrl.trim() : "";

  // ── Resolve the test image URL ────────────────────────────────────────────
  let sampleImageUrl = provided;
  if (!sampleImageUrl) {
    if (engine.kind === "utility") {
      res.status(400).json({
        error: "test_not_supported",
        message: `Test not supported for utility engine "${engine.id}" without an explicit sampleImageUrl. Utility engines like auto-subtitle expect a video URL, not the bundled face placeholder.`,
      });
      return;
    }
    try {
      const buf = await fs.readFile(TEST_FACE_ASSET);
      const blob = new Blob([new Uint8Array(buf)], { type: "image/jpeg" });
      sampleImageUrl = falUploadOverride
        ? await falUploadOverride(blob)
        : await fal.storage.upload(blob);
    } catch (err) {
      logger.warn({ err, engineId: id }, "[adminEngines/test] Failed to upload test asset to fal.storage");
      res.status(500).json({
        error: "upload_failed",
        message: err instanceof Error ? err.message : "Failed to upload test image",
      });
      return;
    }
  }

  // ── Build a minimal valid pipeline-params object using engine defaults ───
  const aspectRatio = engine.defaultAspectRatio ?? "16:9";
  // Reverse-map fal → wizard if the schema's aspect_ratio entry uses the
  // landscape/portrait/square map. The interpreter will translate back.
  const aspectRatioWizard = aspectRatio === "16:9" ? "landscape"
    : aspectRatio === "9:16" ? "portrait"
    : aspectRatio === "1:1" ? "square"
    : aspectRatio;

  const pipelineParams: Record<string, unknown> = {
    imageUrl: sampleImageUrl,
    referenceImageUrl: sampleImageUrl,
    videoUrl: sampleImageUrl,
    motionPrompt: "Synthetic admin test: subtle camera push-in, gentle motion.",
    imagePrompt: "Synthetic admin test portrait, neutral background, soft lighting.",
    durationSec: engine.defaultDurationSec ?? 6,
    aspectRatio: aspectRatioWizard,
    resolution: engine.defaultResolution ?? undefined,
    mode: engine.defaultMode ?? undefined,
    generateAudio: false,
    endUserId: `admin-test-${Date.now()}`,
    dialogueText: null,
    negativePrompt: undefined,
  };

  // ── Pipe through audio handling + interpreter ─────────────────────────────
  let falInput: Record<string, unknown>;
  try {
    const augmented = applyAudioHandling(engine, pipelineParams, null);
    falInput = buildEngineInput(engine, augmented);
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: {
        message: err instanceof Error ? err.message : "Failed to build engine input",
        stage: "buildEngineInput",
      },
    });
    return;
  }

  // ── Call fal (or the test override) ───────────────────────────────────────
  const startedAt = Date.now();
  try {
    const subscribe = falSubscribeOverride ?? ((endpoint: string, opts: { input: Record<string, unknown>; logs?: boolean }) =>
      fal.subscribe(endpoint, opts) as Promise<{ requestId?: string | null; data?: unknown }>);
    const result = await subscribe(engine.endpointId, { input: falInput, logs: true });
    const durationMs = Date.now() - startedAt;
    res.json({
      ok: true,
      engineId: engine.id,
      endpointId: engine.endpointId,
      falInput,
      falResult: result,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : "Unknown error";
    const errBody = err && typeof err === "object" && "body" in err
      ? (err as { body?: unknown }).body
      : undefined;
    const errStatus = err && typeof err === "object" && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
    logger.warn({ err, engineId: engine.id }, "[adminEngines/test] fal.subscribe failed");
    res.json({
      ok: false,
      engineId: engine.id,
      endpointId: engine.endpointId,
      falInput,
      durationMs,
      error: {
        message,
        body: errBody,
        status: errStatus,
      },
    });
  }
});

export default router;
