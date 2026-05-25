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

/** Shape returned by the submit override — mirrors the fal SDK's InQueueQueueStatus.request_id. */
type FalSubmit = (
  endpoint: string,
  opts: { input: Record<string, unknown> },
) => Promise<{ request_id: string }>;
let falSubmitOverride: FalSubmit | null = null;

/** Test helper: replace fal.queue.submit used by POST /:id/test. */
export function __setFalSubmitForTest(impl: FalSubmit | null): void {
  falSubmitOverride = impl;
}

/** Shape returned by the poll override — one call per GET /:id/test/poll/:requestId. */
type FalPollResult = {
  done: boolean;
  ok?: boolean;
  falResult?: unknown;
  error?: { message: string; body?: unknown; status?: unknown };
  phase?: string;
  queuePosition?: number;
  durationMs?: number;
};
type FalPoll = (endpoint: string, requestId: string) => Promise<FalPollResult>;
let falPollOverride: FalPoll | null = null;

/** Test helper: replace fal.queue.status/result used by GET /:id/test/poll/:requestId. */
export function __setFalPollForTest(impl: FalPoll | null): void {
  falPollOverride = impl;
}

// ────────────────────────────────────────────────────────────────────────────
// Submit-timestamp map (durationMs source of truth)
//
// `fal.queue.submit` returns a requestId synchronously but doesn't expose
// when the job actually started running. To report the real submit→done
// runtime back to the workbench we stash the submit timestamp keyed by
// requestId; the poll handler reads it on the terminal transition and
// deletes the entry. A 30-minute TTL guards against admins closing the
// workbench mid-poll and orphaning entries forever (longest fal video
// engine SLA is ~5 min; 30 min is a generous ceiling).
// ────────────────────────────────────────────────────────────────────────────

const SUBMIT_TIMESTAMP_TTL_MS = 30 * 60 * 1000;
const submitTimestamps = new Map<string, number>();

function pruneSubmitTimestamps(now: number = Date.now()): void {
  for (const [requestId, submittedAt] of submitTimestamps) {
    if (now - submittedAt > SUBMIT_TIMESTAMP_TTL_MS) {
      submitTimestamps.delete(requestId);
    }
  }
}

/** Test helper: reset the submit-timestamp map between cases. */
export function __resetSubmitTimestampsForTest(): void {
  submitTimestamps.clear();
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
  /**
   * Transform/scene prompt for image engines (image-to-image + text-to-image).
   * For image-to-image this describes how to transform the source; for
   * text-to-image it is the whole generation prompt. Ignored by video/utility.
   */
  imagePrompt?: string;
  /** Override the engine's default motion prompt. Falls back to TEST_MOTION_PROMPT. */
  motionPrompt?: string;
  /**
   * Override the dialogue text routed through applyAudioHandling.
   *   `string`     — use as-is (overrides TEST_DIALOGUE_TEXT)
   *   `null`       — explicit silence (no voiceover cue at all)
   *   `undefined`  — fall back to engine-appropriate default (TEST_DIALOGUE_TEXT
   *                  for audio engines, null for utility engines)
   */
  dialogueText?: string | null;
  /** Override the default duration (seconds). Must be in engine.allowedDurationsSec when set. */
  durationSec?: number;
  /** Override the default aspect ratio. Accepts wizard format ("landscape"/"square"/"portrait") OR fal format ("16:9"/"1:1"/"9:16"/etc.). */
  aspectRatio?: string;
  /** Override the default resolution. Must be in engine.allowedResolutions when set. */
  resolution?: string;
  /** Override the default mode. Must be in engine.supportedModes when set. */
  mode?: string;
  /** Override the generateAudio default. */
  generateAudio?: boolean;
  /**
   * Engine-specific param overrides — merged into pipelineParams before
   * applyAudioHandling. Keys are the schema's `from` keys (e.g. "cfgScale",
   * "negativePrompt"). Used to surface engine-specific knobs in the admin
   * Test panel without hard-coding them server-side.
   */
  extraParams?: Record<string, unknown>;
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
/**
 * Synthetic test fixtures. These are deliberately specific (not generic
 * prose) so admins can judge from the output video whether the engine
 * honored what we sent:
 *
 *   - Motion: observable beats with direction + timing. If the subject
 *     isn't doing what's described, the engine is ignoring motion prompts.
 *   - Dialogue: a recognizable phrase with phonetically diverse syllables.
 *     If the audio garbles it, the engine's voice synthesis is the issue.
 *     If the lips don't match for `native_lipsync` engines, lipsync is.
 *
 * Both flow through the same code paths as the wizard's real generation
 * (applyAudioHandling + buildEngineInput), so the synthetic test exercises
 * the engine's actual contract, not just "does fal accept the JSON."
 */
const TEST_MOTION_PROMPT =
  "Subject slowly turns their head 45 degrees to the left over 2 seconds, " +
  "then returns to center while making eye contact with the camera. " +
  "Slow dolly push-in throughout. Soft window light from the left.";

const TEST_DIALOGUE_TEXT =
  "This is a synthetic engine test. The quick brown fox jumps over the lazy dog.";

/**
 * Default prompt for the image benches. Specific enough that an admin can tell
 * from the output whether the engine honored the prompt — for image-to-image
 * it should transform the supplied face; for text-to-image it should render
 * the scene from scratch.
 */
const TEST_IMAGE_PROMPT =
  "A cinematic portrait of the subject as a 1920s film noir detective in a " +
  "rain-soaked alley, dramatic chiaroscuro lighting, volumetric fog.";

/**
 * Which bench a given engine drives. Video and utility map straight from
 * `kind`; image engines split on whether the param schema declares a source
 * image (`referenceImageUrl`/`imageUrl`) — if it does it's image-to-image,
 * otherwise text-to-image (prompt only).
 */
export type EngineBenchType = "text-to-image" | "image-to-image" | "video" | "utility";

export function engineBenchType(engine: {
  kind: string;
  paramSchema?: unknown;
}): EngineBenchType {
  if (engine.kind === "video") return "video";
  if (engine.kind === "utility") return "utility";
  const params =
    (engine.paramSchema as { params?: Array<{ from?: string }> } | null | undefined)?.params ?? [];
  const needsSourceImage = params.some(
    (p) => p.from === "referenceImageUrl" || p.from === "imageUrl",
  );
  return needsSourceImage ? "image-to-image" : "text-to-image";
}

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

  // ── Configure fal client with API key ────────────────────────────────────
  const falApiKey = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
  if (falApiKey) {
    fal.config({ credentials: falApiKey });
  }

  const benchType = engineBenchType(engine);

  // ── Resolve the source asset (only the benches that consume one) ──────────
  //   text-to-image → no source asset at all (prompt only)
  //   image-to-image / video → a source image (uploaded test face if none given)
  //   utility → an explicit video URL (the face placeholder is meaningless)
  let sampleImageUrl = provided;
  if (benchType === "utility" && !sampleImageUrl) {
    res.status(400).json({
      error: "test_not_supported",
      message: `Test not supported for utility engine "${engine.id}" without an explicit sampleImageUrl. Utility engines like auto-subtitle expect a video URL, not the bundled face placeholder.`,
    });
    return;
  }
  const needsSourceImage = benchType === "image-to-image" || benchType === "video";
  if (needsSourceImage && !sampleImageUrl) {
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

  // ── Build the pipeline-params object — bespoke per bench ──────────────────
  // Aspect ratio: admin may pass wizard format ("landscape"/"square"/"portrait")
  // or fal format ("16:9" etc.). We always feed the interpreter wizard format
  // (its paramSchema map handles the translation).
  const aspectRatioRaw = body.aspectRatio ?? engine.defaultAspectRatio ?? "16:9";
  const aspectRatioWizard = aspectRatioRaw === "16:9" ? "landscape"
    : aspectRatioRaw === "9:16" ? "portrait"
    : aspectRatioRaw === "1:1" ? "square"
    : aspectRatioRaw; // already wizard format ("landscape" etc.) or engine-specific

  const imagePrompt = typeof body.imagePrompt === "string" && body.imagePrompt.trim()
    ? body.imagePrompt.trim()
    : TEST_IMAGE_PROMPT;

  const endUserId = `admin-test-${Date.now()}`;
  let pipelineParams: Record<string, unknown>;

  if (benchType === "text-to-image") {
    // Prompt only — no source image, no motion/dialogue/duration.
    pipelineParams = {
      imagePrompt,
      aspectRatio: aspectRatioWizard,
      resolution: body.resolution ?? engine.defaultResolution ?? undefined,
      endUserId,
    };
  } else if (benchType === "image-to-image") {
    // Source image + transform prompt. No motion, dialogue, or duration.
    pipelineParams = {
      imagePrompt,
      referenceImageUrl: sampleImageUrl,
      imageUrl: sampleImageUrl,
      aspectRatio: aspectRatioWizard,
      resolution: body.resolution ?? engine.defaultResolution ?? undefined,
      endUserId,
    };
  } else if (benchType === "utility") {
    // The "sample" is a video URL; caption styling rides in via extraParams.
    pipelineParams = {
      videoUrl: sampleImageUrl,
      endUserId,
    };
  } else {
    // Video — motion + (optional) dialogue + duration + audio.
    const motionPrompt = typeof body.motionPrompt === "string" && body.motionPrompt.trim()
      ? body.motionPrompt
      : TEST_MOTION_PROMPT;
    pipelineParams = {
      imageUrl: sampleImageUrl,
      referenceImageUrl: sampleImageUrl,
      videoUrl: sampleImageUrl,
      motionPrompt,
      durationSec: typeof body.durationSec === "number" && body.durationSec > 0
        ? body.durationSec
        : engine.defaultDurationSec ?? 6,
      aspectRatio: aspectRatioWizard,
      resolution: body.resolution ?? engine.defaultResolution ?? undefined,
      mode: body.mode ?? engine.defaultMode ?? undefined,
      // Audio engines (Veo native_lipsync, Kling voice_control, Seedance
      // native_audio_boolean) should generate audio by default. The flag is
      // silently dropped by engines that don't declare a generate_audio param.
      generateAudio: typeof body.generateAudio === "boolean"
        ? body.generateAudio
        : engine.audioHandling !== "none",
      endUserId,
      // dialogueText is routed by applyAudioHandling — see below.
      negativePrompt: undefined,
    };
  }

  // Engine-specific params from the admin override. Merged AFTER the
  // universal field set so explicit per-engine knobs (cfg_scale,
  // negative_prompt, etc.) win.
  if (body.extraParams && typeof body.extraParams === "object") {
    for (const [key, value] of Object.entries(body.extraParams)) {
      if (value !== undefined && value !== null && value !== "") {
        pipelineParams[key] = value;
      }
    }
  }

  // ── Pipe through audio handling + interpreter ─────────────────────────────
  // Resolve the dialogue cue:
  //   - body.dialogueText === undefined → engine-appropriate default
  //   - body.dialogueText === null      → explicit silence (no cue routed)
  //   - body.dialogueText === ""        → explicit silence
  //   - otherwise                       → use as-is
  let dialogueForTest: string | null;
  if (body.dialogueText === undefined) {
    dialogueForTest = engine.audioHandling === "none" ? null : TEST_DIALOGUE_TEXT;
  } else if (body.dialogueText === null || body.dialogueText === "") {
    dialogueForTest = null;
  } else {
    dialogueForTest = body.dialogueText;
  }
  let falInput: Record<string, unknown>;
  try {
    const augmented = applyAudioHandling(engine, pipelineParams, dialogueForTest);
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

  // ── Submit to fal queue (returns requestId immediately — no blocking wait) ──
  try {
    const submit = falSubmitOverride
      ?? (async (endpoint: string, opts: { input: Record<string, unknown> }) => {
        const result = await (fal.queue.submit as (
          endpoint: string,
          opts: { input: Record<string, unknown> },
        ) => Promise<{ request_id: string }>)(endpoint, opts);
        return { request_id: result.request_id };
      });

    const submitted = await submit(engine.endpointId, { input: falInput });

    // Stash submit timestamp so the poll endpoint can compute the real
    // job runtime (submit → done) rather than just the result-fetch
    // window. Pruned opportunistically on each new submit to keep the
    // map from growing unbounded if admins close the workbench mid-poll.
    pruneSubmitTimestamps();
    submitTimestamps.set(submitted.request_id, Date.now());

    res.status(202).json({
      status: "submitted",
      requestId: submitted.request_id,
      engineId: engine.id,
      endpointId: engine.endpointId,
      falInput,
      benchType,
      testFixtures: {
        motionPrompt: TEST_MOTION_PROMPT,
        dialogueText: dialogueForTest,
        imagePrompt: benchType === "image-to-image" || benchType === "text-to-image"
          ? imagePrompt
          : undefined,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const errBody = err && typeof err === "object" && "body" in err
      ? (err as { body?: unknown }).body
      : undefined;
    const errStatus = err && typeof err === "object" && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
    logger.warn({ err, engineId: engine.id }, "[adminEngines/test] fal.queue.submit failed");
    // Bad Gateway — the failure originated downstream at fal, not in
    // this server. Makes the success/failure split observable for any
    // non-browser consumer (curl, monitoring) without parsing the body.
    res.status(502).json({
      ok: false,
      engineId: engine.id,
      endpointId: engine.endpointId,
      falInput,
      error: { message, body: errBody, status: errStatus },
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 6b. GET /api/admin/engines/:id/test/poll/:requestId
//
// Checks the fal queue for a previously-submitted test job. Returns:
//   { done: false, phase, queuePosition? }       — still in flight
//   { done: true, ok: true, falResult, durationMs } — completed successfully
//   { done: true, ok: false, error }               — fal returned an error
//                                                    OR fal reported a
//                                                    FAILED/CANCELED status
//
// The frontend polls this every 3 s after POST /:id/test returns 202.
// ────────────────────────────────────────────────────────────────────────────

/** Statuses where we expect the job to still be in flight. */
const FAL_NON_TERMINAL = new Set(["IN_QUEUE", "IN_PROGRESS"]);

router.get(
  "/admin/engines/:id/test/poll/:requestId",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const requestId = String(req.params["requestId"] ?? "");

    const engine = await fetchEngineById(id);
    if (!engine) {
      res.status(404).json({ error: "Engine not found" });
      return;
    }

    // Resolve durationMs from the submit timestamp recorded at POST /:id/test.
    // The map entry is the source of truth for "when did this job actually
    // start"; the result-fetch window is not.
    const computeDurationMs = (): number | undefined => {
      const submittedAt = submitTimestamps.get(requestId);
      return submittedAt !== undefined ? Date.now() - submittedAt : undefined;
    };

    const falApiKey = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
    if (falApiKey) fal.config({ credentials: falApiKey });

    if (falPollOverride) {
      try {
        const result = await falPollOverride(engine.endpointId, requestId);
        if (result.done) {
          // Test overrides may already carry a durationMs (the override
          // owns the whole shape). When they don't, fill it in from the
          // submit-timestamp map. Either way, clean up on terminal state.
          const enriched =
            result.durationMs === undefined
              ? { ...result, durationMs: computeDurationMs() }
              : result;
          submitTimestamps.delete(requestId);
          res.json(enriched);
        } else {
          res.json(result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        submitTimestamps.delete(requestId);
        res.json({ done: true, ok: false, error: { message } });
      }
      return;
    }

    try {
      const status = await (fal.queue.status as (
        endpoint: string,
        opts: { requestId: string; logs?: boolean },
      ) => Promise<{ status: string; queue_position?: number }>)(engine.endpointId, {
        requestId,
        logs: false,
      });

      if (status.status === "COMPLETED") {
        const result = await (fal.queue.result as (
          endpoint: string,
          opts: { requestId: string },
        ) => Promise<unknown>)(engine.endpointId, { requestId });
        const durationMs = computeDurationMs();
        submitTimestamps.delete(requestId);
        res.json({
          done: true,
          ok: true,
          falResult: result,
          durationMs,
          requestId,
        });
        return;
      }

      // FAILED / CANCELED (and any unknown non-terminal-success status fal
      // might add in the future) are terminal failures — without this branch
      // the workbench polls forever.
      if (!FAL_NON_TERMINAL.has(status.status)) {
        logger.warn(
          { engineId: engine.id, requestId, falStatus: status.status },
          "[adminEngines/poll] fal reported terminal-failure status",
        );
        const durationMs = computeDurationMs();
        submitTimestamps.delete(requestId);
        res.json({
          done: true,
          ok: false,
          error: { message: `fal job ${status.status.toLowerCase()}`, status: status.status },
          durationMs,
        });
        return;
      }

      res.json({
        done: false,
        phase: status.status,
        queuePosition: status.queue_position,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const errBody = err && typeof err === "object" && "body" in err
        ? (err as { body?: unknown }).body
        : undefined;
      const errStatus = err && typeof err === "object" && "status" in err
        ? (err as { status?: unknown }).status
        : undefined;
      logger.warn({ err, engineId: engine.id, requestId }, "[adminEngines/poll] fal.queue poll failed");
      submitTimestamps.delete(requestId);
      res.json({ done: true, ok: false, error: { message, body: errBody, status: errStatus } });
    }
  },
);

export default router;
