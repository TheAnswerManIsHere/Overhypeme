/**
 * Video Pipeline Runner — async, in-memory orchestrator for the wizard's
 * multi-stage video flow (PuLID stylization → user checkpoint → video gen →
 * caption burn-in → R2 upload → meme row).
 *
 * Engine resolution is fully data-driven via `engineInterpreter`:
 *   - The Stage 2 engine row is loaded fresh at job start (or admin override),
 *     and its `paramSchema` jsonb is walked by `buildEngineInput` to construct
 *     the fal.subscribe input. Adding/swapping engines is a row update — no
 *     code change here.
 *   - Voice/dialogue routing per engine (Veo lipsync, Kling voice_text, Grok
 *     prompt cue, Seedance generate_audio boolean) goes through
 *     `applyAudioHandling` before the interpreter sees the params.
 *   - The Stage 1 (PuLID) and Stage 3 (auto-subtitle) engines are loaded for
 *     their `expectedRunMs` / cost hints; the actual calls remain in
 *     specialised helpers (`generateAiMemeBackgroundFromReference`,
 *     `addCaptionsToVideo`) because their interfaces are baked into the
 *     `aiMemePipeline.ts` / `falAutoSubtitle.ts` wrappers.
 *
 * Job state lives in a process-local Map with a 60-minute TTL — matches the
 * wizard's polling cadence so it survives page reloads on a single instance.
 * Persistent state lives on `video_jobs` (per-stage cost, engine ids, source
 * mode, options snapshot, error code/message, checkpoint/proceeded/completed
 * timestamps). Phase transitions push their data to the row promptly so
 * cancelled/expired in-memory state still leaves a paper trail.
 *
 * Phases (state machine):
 *
 *   queued                              ──┐
 *     │ source mode: stylize-then-video │ source mode: use-photo-as-is
 *     ▼                                  │   or use-existing-ai-image
 *   stage1_pulid                          │
 *     │   no-face                        │
 *     ├─→ stage1_no_face_review ─────────┤  (user picks: regenerate w/ new
 *     │                                  │   look, or fallback text-to-image)
 *     │   NSFW classifier hit            │
 *     ├─→ failed (errorCode=moderation)  │
 *     │                                  │
 *     ▼                                  ▼
 *   stage1_review (checkpoint) ──────► stage2_video
 *     proceed()                           │
 *                                         ▼
 *                                     stage2_subtitle
 *                                         │
 *                                         ▼
 *                                     uploading
 *                                         │
 *                                         ▼
 *                                     completed (memeId + permalinkUrl set)
 *
 * Cancel terminates from any non-terminal phase. Failed/canceled/completed
 * are terminal.
 */

import { db } from "@workspace/db";
import {
  videoJobsTable,
  uploadImageMetadataTable,
  lookStylesTable,
  motionPresetsTable,
  factsTable,
  type Engine,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import { ObjectStorageService } from "./objectStorage";
import {
  loadEngine,
  loadDefaultEngine,
  buildEngineInput,
  MissingRequiredParamError,
} from "./engineInterpreter";
import { applyAudioHandling } from "./engineAudio";
import { cropBufferToAspect, aspectRatioToPulidImageSize } from "./imageFraming";
import { generateAiMemeBackgroundFromReference, generateAiMemeBackgroundStandalone } from "./aiMemePipeline";
import { generateVideoDirection } from "./videoDirection";
import { addCaptionsToVideo } from "./falAutoSubtitle";
import { classifyAndDecide } from "./moderation/nsfwClassifier";
import { BudgetGateError, checkBudget, recordCost } from "./budgetGate";
import { getCachedPrice } from "./falPricing";
import { computeVideoCost, resolveVideoDimensions } from "./costComputation";
import { createMemeRecord, resolveMemeDecisions } from "./createMemeRecord";
import {
  buildAuthorizationSnapshot,
  decisionFromSnapshot,
  type AuthorizationSnapshot,
  type Principal,
} from "./featureAccess";
import { logger } from "./logger";

// ─── Public types ─────────────────────────────────────────────────────────────

export type SourceMode = "stylize-then-video" | "use-photo-as-is" | "use-existing-ai-image";

export type AspectRatio = "landscape" | "square" | "portrait";

/** Maps the wizard's aspect-ratio words to fal-style ratios. */
const ASPECT_RATIO_TO_FAL: Record<AspectRatio, string> = {
  landscape: "16:9",
  square: "1:1",
  portrait: "9:16",
};

const PULID_IMAGE_ENGINE_ID = "pulid-flux";
const SUBTITLE_ENGINE_ID = "fal-auto-subtitle";

export type Phase =
  | "queued"
  | "stage1_pulid"
  | "stage1_review"
  | "stage1_no_face_review"
  | "stage2_video"
  | "stage2_subtitle"
  | "uploading"
  | "completed"
  | "failed"
  | "canceled";

export interface JobState {
  jobId: string;
  userId: string;
  factId: number;
  createdAt: number;
  expiresAt: number;
  phase: Phase;
  progress: number;
  etaSeconds?: number;

  sourceMode: SourceMode;
  sourceImagePath: string;
  lookStyleId: string | null;
  motionPresetId: string | null;
  videoEngineId: string;
  engineMode: string | null;
  customModePrompt: string | null;
  durationSec: number;
  resolution: string;
  aspectRatio: AspectRatio;
  /**
   * Normalized focus point {x,y} in [0,1] for cropping the source image to the
   * chosen aspect ratio in Stage 1 (drag-to-reposition). null = centre crop.
   */
  framingFocus: { x: number; y: number } | null;
  name: string | null;
  pronouns: string | null;
  renderedFactText: string | null;

  stylizedStillObjectPath?: string;
  noFaceFallbackUsed?: boolean;
  rawVideoUrl?: string;
  finalVideoObjectPath?: string;
  memeId?: number;
  permalinkUrl?: string;

  stage1CostUsd?: number;
  stage2CostUsd?: number;
  stage3CostUsd?: number;
  stage1Attempts: number;

  /** DB-side video_jobs row id, used for the imageSource.videoJobId field. */
  videoJobRowId?: number;

  errorCode?: string;
  errorMessage?: string;

  /**
   * The decisions that authorized this job, resolved at submission. Mirrors
   * what was persisted on the `video_jobs` row; the row is the durable copy and
   * this is the in-process one. Kept off the wire by sanitization.
   */
  _authorizationSnapshot: AuthorizationSnapshot;
  /** Internal scheduling state — kept off the wire by sanitization. */
  _phaseStartedAt: number;
  /** Optional floor boosted by fal queue/progress callbacks (Part 3). */
  _falProgressFloor?: number;
}

export interface StartJobInput {
  userId: string;
  factId: number;
  sourceMode: SourceMode;
  sourceImagePath: string;
  lookStyleId?: string | null;
  motionPresetId?: string | null;
  /** Engine id from the engines table. Defaults to the active default video engine. */
  videoEngineId?: string;
  engineMode?: string | null;
  customModePrompt?: string | null;
  durationSec: number;
  resolution: string;
  aspectRatio: AspectRatio;
  /** Normalized focus point {x,y} in [0,1] for the Stage-1 source crop. */
  framingFocus?: { x: number; y: number } | null;
  name?: string | null;
  pronouns?: string | null;
  /** Rendered fact text (name/pronouns substituted) — drives the engine's voice slot. */
  renderedFactText?: string | null;
  /**
   * The submitting request's principal. Required: this pipeline runs long after
   * the request that started it, so the only moment "view as user" is visible
   * is right here. Resolving gates later from the stored admin flag — which is
   * what used to happen inside `createMemeRecord` — cannot see it at all.
   */
  principal: Principal;
  /**
   * The caller's own `video_generation` decision, from the SAME `can()` call
   * that gated the request. Required, not re-derived here.
   *
   * This function used to call `can(principal, "video_generation")` a second
   * time internally, which opened a window: if the grid was toggled between
   * the route's gate and this call — or if resolution itself failed the
   * second time for any reason — the job would still start, but its permanent
   * `authorization_snapshot` would record `false` for the very decision that
   * admitted it, corrupting the record in exactly the case it exists to
   * protect. The route's decision is definitionally what authorized this call
   * (it 403s before ever reaching here), so that is the value that must be
   * persisted — not a fresh, possibly-different answer to the same question.
   */
  videoGenerationDecision: boolean;
}

export class VideoJobError extends Error {
  public readonly status: number;
  public readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body["error"] === "string" ? body["error"] : "video_job_error");
    this.name = "VideoJobError";
    this.status = status;
    this.body = body;
  }
}

// ─── Per-engine EMA tracking for expected run ms ─────────────────────────────

const stage2EmaByEngine = new Map<string, number>();
const SUBTITLE_DEFAULT_EXPECTED_MS = 8_000;
let stage3Ema = SUBTITLE_DEFAULT_EXPECTED_MS;
const PULID_DEFAULT_EXPECTED_MS = 18_000;
let stage1Ema = PULID_DEFAULT_EXPECTED_MS;

const EMA_ALPHA = 0.3;
function updateEma(prev: number, sample: number): number {
  return Math.round(prev * (1 - EMA_ALPHA) + sample * EMA_ALPHA);
}

/**
 * Server-computed progress that advances continuously within each phase using
 * an exponential asymptote toward the phase ceiling. This replaces the
 * static per-phase floor stored in `job.progress`, giving the client bar
 * smooth monotonic motion at every poll interval.
 *
 * Budget allocation:
 *   queued                  → 0.02
 *   stage1_pulid            → 0.00 .. 0.25
 *   stage1_review / no_face → 0.25  (checkpoint pause — intentional)
 *   stage2_video            → 0.25 .. 0.85  (stylize-then-video)
 *                           → 0.00 .. 0.85  (use-photo-as-is / use-existing-ai-image)
 *   stage2_subtitle         → 0.85 .. 0.95
 *   uploading               → 0.97
 *   completed               → 1.00
 *   failed / canceled       → last recorded floor (job.progress)
 */
function computeProgress(job: JobState): number {
  if (job.phase === "completed") return 1;
  if (job.phase === "failed" || job.phase === "canceled") {
    return job.progress;
  }
  if (job.phase === "queued") return 0.02;
  if (job.phase === "stage1_review" || job.phase === "stage1_no_face_review") return 0.25;
  if (job.phase === "uploading") return 0.97;

  const elapsed = Date.now() - job._phaseStartedAt;
  const falFloor = job._falProgressFloor ?? 0;

  let curve: number;

  if (job.phase === "stage1_pulid") {
    const tau = Math.max(1, stage1Ema);
    const inner = 0.05 + 0.90 * (1 - Math.exp(-elapsed / tau));
    curve = inner * 0.25;
  } else if (job.phase === "stage2_video") {
    const tau = Math.max(1, stage2EmaByEngine.get(job.videoEngineId) ?? 30_000);
    const inner = 0.10 + 0.80 * (1 - Math.exp(-elapsed / tau));
    curve = job.sourceMode !== "stylize-then-video"
      ? inner * 0.85
      : 0.25 + inner * 0.60;
  } else if (job.phase === "stage2_subtitle") {
    const tau = Math.max(1, stage3Ema);
    const inner = 0.10 + 0.85 * (1 - Math.exp(-elapsed / tau));
    curve = 0.85 + inner * 0.10;
  } else {
    return job.progress;
  }

  return Math.max(curve, falFloor);
}

// ─── In-memory job store with TTL ─────────────────────────────────────────────

const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map<string, JobState>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.expiresAt <= now) jobs.delete(id);
  }
}

// ─── Test hooks (allow stubbing fal calls without monkey-patching modules) ───

export interface PipelineTestHooks {
  /**
   * Stage 1 stylization. Returns the stylized still object path, or null when
   * no face was detected (triggers stage1_no_face_review).
   */
  runStage1?: (job: JobState) => Promise<{ stillObjectPath: string | null }>;
  /**
   * No-face fallback still generation (text-to-image). Returns the still
   * object path, or null to fall back to promoting the source photo.
   */
  runStage1Fallback?: (job: JobState) => Promise<{ stillObjectPath: string | null }>;
  /**
   * NSFW classifier outcome for the stylized still. Default uses the real
   * fal classifier. Tests can return "accept" / "reject" deterministically.
   */
  classifyStill?: (objectPath: string) => Promise<"accept" | "reject">;
  /** Stage 2 fal.subscribe wrapper. Returns the temporary video URL. */
  runStage2?: (job: JobState, stillObjectPath: string) => Promise<{ videoUrl: string }>;
  /** Stage 3 caption burn-in. Returns the captioned video URL. */
  runStage3?: (videoUrl: string) => Promise<{ captionedVideoUrl: string }>;
  /** Upload to R2/GCS. Returns the object path. */
  uploadFinal?: (captionedUrl: string, jobId: string) => Promise<string>;
}

let testHooks: PipelineTestHooks = {};

/** Test-only: install hooks. Pass `{}` to clear. */
export function __setPipelineTestHooks(hooks: PipelineTestHooks): void {
  testHooks = hooks;
}

/** Test-only: reset in-memory state (jobs + EMAs). */
/**
 * Test-only export of the internal `computeProgress` function so unit tests
 * can drive its inputs directly. Production callers should always go through
 * `serializeJobState` instead.
 */
export const __computeProgressForTests = computeProgress;

export function __resetPipelineState(): void {
  jobs.clear();
  stage2EmaByEngine.clear();
  stage1Ema = PULID_DEFAULT_EXPECTED_MS;
  stage3Ema = SUBTITLE_DEFAULT_EXPECTED_MS;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asNumberArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

/**
 * Validates pipeline params against the engine row's allowedDurationsSec /
 * allowedResolutions / allowedAspectRatios columns. The aspect-ratio check
 * compares against the engine's own canonical strings (e.g. "16:9") via
 * the ASPECT_RATIO_TO_FAL mapping; the wizard speaks landscape/square/portrait.
 */
function validateEngineParams(engine: Engine, input: StartJobInput): string | null {
  const durations = asNumberArray(engine.allowedDurationsSec);
  if (durations.length > 0 && !durations.includes(input.durationSec)) {
    return `Duration ${input.durationSec}s is not allowed for engine ${engine.id}. Allowed: ${durations.join(", ")}.`;
  }
  const resolutions = asStringArray(engine.allowedResolutions);
  if (resolutions.length > 0 && !resolutions.includes(input.resolution)) {
    return `Resolution ${input.resolution} is not allowed for engine ${engine.id}. Allowed: ${resolutions.join(", ")}.`;
  }
  const aspectRatios = asStringArray(engine.allowedAspectRatios);
  const falAspect = ASPECT_RATIO_TO_FAL[input.aspectRatio];
  if (aspectRatios.length > 0 && !aspectRatios.includes(falAspect)) {
    return `Aspect ratio ${input.aspectRatio} is not supported by engine ${engine.id}.`;
  }
  // Mode is optional; only enforce when the engine declares supported modes.
  const modes = asStringArray(engine.supportedModes);
  if (input.engineMode && modes.length > 0 && !modes.includes(input.engineMode)) {
    return `Mode "${input.engineMode}" is not supported by engine ${engine.id}.`;
  }
  return null;
}

// ─── Pre-flight cost estimate ─────────────────────────────────────────────────

const STAGE1_FALLBACK_COST = 0.03;
const STAGE3_FALLBACK_COST = 0.02;

function engineNumeric(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function estimateStage2Cost(
  engine: Engine,
  durationSec: number,
  aspectRatio: AspectRatio,
  resolution: string,
): Promise<number> {
  try {
    const price = await getCachedPrice(engine.endpointId);
    const dims = resolveVideoDimensions(ASPECT_RATIO_TO_FAL[aspectRatio], resolution);
    const { costUsd } = computeVideoCost(
      { width: dims.width, height: dims.height, fps: 24, durationSeconds: durationSec },
      price,
    );
    return costUsd;
  } catch (err) {
    logger.warn({ err, engineId: engine.id }, "[videoPipeline] estimateStage2Cost: pricing unavailable — using engine fallback");
    return engineNumeric(engine.estimatedCostUsdPerSecond, 0.05) * durationSec;
  }
}

async function estimateTotalCost(engine: Engine, input: StartJobInput): Promise<number> {
  const stage1 = input.sourceMode === "stylize-then-video" ? STAGE1_FALLBACK_COST : 0;
  const stage2 = await estimateStage2Cost(engine, input.durationSec, input.aspectRatio, input.resolution);
  const stage3 = STAGE3_FALLBACK_COST;
  return stage1 + stage2 + stage3;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the engine for a job — either the requested id or the active default.
 * Throws VideoJobError on unknown engine / no default configured.
 */
export async function resolveVideoEngine(engineId?: string | null): Promise<Engine> {
  if (engineId) {
    const found = await loadEngine(engineId);
    if (!found) {
      throw new VideoJobError(400, { error: "unknown_engine", engineId });
    }
    if (found.kind !== "video") {
      throw new VideoJobError(400, { error: "not_a_video_engine", engineId });
    }
    return found;
  }
  try {
    return await loadDefaultEngine("video");
  } catch (err) {
    logger.error({ err }, "[videoPipeline] No default video engine configured");
    throw new VideoJobError(503, { error: "video_engine_not_configured" });
  }
}

/**
 * Validate inputs, run the pre-flight budget gate, insert a video_jobs row,
 * and schedule the async pipeline. Returns `{ jobId }` immediately. Throws
 * VideoJobError on validation / budget failures — the row is NOT created if
 * the budget gate denies.
 */
export async function startVideoJob(input: StartJobInput): Promise<{ jobId: string }> {
  pruneExpired();

  // ── Engine + param validation ─────────────────────────────────────
  const engine = await resolveVideoEngine(input.videoEngineId);
  const paramErr = validateEngineParams(engine, input);
  if (paramErr) {
    throw new VideoJobError(400, { error: "invalid_engine_params", message: paramErr });
  }

  if (input.sourceMode === "stylize-then-video" && !input.lookStyleId) {
    throw new VideoJobError(400, { error: "look_style_required" });
  }

  if (input.lookStyleId) {
    const [look] = await db
      .select({ id: lookStylesTable.id })
      .from(lookStylesTable)
      .where(and(eq(lookStylesTable.id, input.lookStyleId), eq(lookStylesTable.isActive, true)))
      .limit(1);
    if (!look) {
      throw new VideoJobError(400, { error: "unknown_look_style", lookStyleId: input.lookStyleId });
    }
  }

  if (input.motionPresetId) {
    const [motion] = await db
      .select({ id: motionPresetsTable.id })
      .from(motionPresetsTable)
      .where(
        and(eq(motionPresetsTable.id, input.motionPresetId), eq(motionPresetsTable.isActive, true)),
      )
      .limit(1);
    if (!motion) {
      throw new VideoJobError(400, { error: "unknown_motion_preset", motionPresetId: input.motionPresetId });
    }
  }

  // ── Pre-flight budget gate ───────────────────────────────────────
  const estimated = await estimateTotalCost(engine, input);
  let budget: Awaited<ReturnType<typeof checkBudget>>;
  try {
    budget = await checkBudget(input.userId, estimated);
  } catch (err) {
    if (err instanceof BudgetGateError) {
      // Deny, but as a retry-able service error — not a 429, which would tell
      // a user hitting a transient failure that they are out of budget (#409).
      throw new VideoJobError(503, { error: "budget_check_unavailable", message: err.message });
    }
    throw err;
  }
  if (!budget.allowed) {
    throw new VideoJobError(429, {
      error: "BUDGET_EXCEEDED",
      currentSpend: budget.currentSpend,
      limit: budget.limit,
      remainingBudget: budget.remainingBudget,
    });
  }

  // ── Resolve what authorizes this job, once, now ──────────────────
  // Both the video gate and the meme gates this job will need at completion
  // are decided here, against the submitting request's principal, and travel
  // with the job from this point on.
  const authorizationSnapshot = buildAuthorizationSnapshot(input.principal, {
    video_generation: input.videoGenerationDecision,
    ...(await resolveMemeDecisions(input.principal)),
  });

  // Defense-in-depth: the route already rejects an unentitled
  // "stylize-then-video" submission, but this is the one place that can't be
  // bypassed by a caller who skips the route check — the snapshot recorded
  // above is what the pipeline (and the persisted meme record) actually acts
  // on, so it's the last point that can still refuse to run PuLID for an
  // account that isn't entitled to it.
  if (
    input.sourceMode === "stylize-then-video" &&
    !decisionFromSnapshot(authorizationSnapshot, "meme_pulid_stylize")
  ) {
    throw new VideoJobError(403, {
      error: "PULID_STYLIZE_LOCKED",
      message: "AI face styling is a Legendary feature. Upgrade your membership to unlock it.",
    });
  }

  // ── Persist the DB row ───────────────────────────────────────────
  // Persistence is a PRECONDITION for starting the job, not a best-effort side
  // task. This used to catch the failure, log a warning, and proceed on
  // in-memory state alone — which meant a restart could leave a job running
  // with no record of what authorized it, and the snapshot would guarantee
  // nothing. No row, no job.
  let videoJobRowId: number | undefined;
  {
    const [row] = await db
      .insert(videoJobsTable)
      .values({
        authorizationSnapshot,
        factId: input.factId,
        imageUrl: input.sourceImagePath,
        lookStyleId: input.lookStyleId ?? null,
        motionPresetId: input.motionPresetId ?? null,
        videoEngineId: engine.id,
        imageEngineId: input.sourceMode === "stylize-then-video" ? PULID_IMAGE_ENGINE_ID : null,
        engineMode: input.engineMode ?? null,
        customModePrompt: input.customModePrompt ?? null,
        sourceMode: input.sourceMode,
        optionsSnapshot: {
          lengthSeconds: input.durationSec,
          resolution: input.resolution,
          aspectRatio: input.aspectRatio,
          framingFocus: input.framingFocus ?? null,
        },
        status: "pending",
        ipAddress: "pipeline",
        userId: input.userId,
        isPrivate: false,
      })
      .returning({ id: videoJobsTable.id });
    videoJobRowId = row?.id;
    if (videoJobRowId == null) {
      throw new VideoJobError(500, { error: "video_job_persist_failed" });
    }
  }

  // ── Seed in-memory state ─────────────────────────────────────────
  const jobId = randomUUID();
  const now = Date.now();
  const state: JobState = {
    jobId,
    userId: input.userId,
    factId: input.factId,
    createdAt: now,
    expiresAt: now + JOB_TTL_MS,
    phase: "queued",
    progress: 0,
    sourceMode: input.sourceMode,
    sourceImagePath: input.sourceImagePath,
    lookStyleId: input.lookStyleId ?? null,
    motionPresetId: input.motionPresetId ?? null,
    videoEngineId: engine.id,
    engineMode: input.engineMode ?? null,
    customModePrompt: input.customModePrompt ?? null,
    durationSec: input.durationSec,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    framingFocus: input.framingFocus ?? null,
    name: input.name ?? null,
    pronouns: input.pronouns ?? null,
    renderedFactText: input.renderedFactText ?? null,
    stage1Attempts: 0,
    videoJobRowId,
    _authorizationSnapshot: authorizationSnapshot,
    _phaseStartedAt: now,
  };
  jobs.set(jobId, state);

  // Schedule the pipeline (fire-and-forget). Errors are caught inside.
  setImmediate(() => { void runPipeline(jobId); });

  return { jobId };
}

/** Owner-only lookup. Returns null when the job doesn't exist or owner mismatch. */
export function getVideoJob(jobId: string, userId: string): JobState | null {
  pruneExpired();
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.userId !== userId) return null;
  return job;
}

/** Sanitized projection for over-the-wire poll responses. */
export function serializeJobState(job: JobState): Record<string, unknown> {
  return {
    jobId: job.jobId,
    factId: job.factId,
    phase: job.phase,
    progress: computeProgress(job),
    etaSeconds: job.etaSeconds,
    sourceMode: job.sourceMode,
    lookStyleId: job.lookStyleId,
    motionPresetId: job.motionPresetId,
    videoEngineId: job.videoEngineId,
    engineMode: job.engineMode,
    durationSec: job.durationSec,
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    stylizedStillObjectPath: job.stylizedStillObjectPath,
    noFaceFallbackUsed: job.noFaceFallbackUsed,
    rawVideoUrl: job.rawVideoUrl,
    finalVideoObjectPath: job.finalVideoObjectPath,
    memeId: job.memeId,
    permalinkUrl: job.permalinkUrl,
    stage1CostUsd: job.stage1CostUsd,
    stage2CostUsd: job.stage2CostUsd,
    stage3CostUsd: job.stage3CostUsd,
    stage1Attempts: job.stage1Attempts,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: new Date(job.createdAt).toISOString(),
  };
}

export async function proceedVideoJob(jobId: string, userId: string): Promise<{ ok: true }> {
  const job = getVideoJob(jobId, userId);
  if (!job) throw new VideoJobError(404, { error: "not_found" });
  if (job.phase !== "stage1_review") {
    throw new VideoJobError(409, { error: "invalid_phase", phase: job.phase });
  }
  setPhase(job, "stage2_video");
  if (job.videoJobRowId) {
    try {
      await db
        .update(videoJobsTable)
        .set({ proceededAt: new Date() })
        .where(eq(videoJobsTable.id, job.videoJobRowId));
    } catch (err) {
      logger.warn({ err, jobId }, "[videoPipeline] failed to record proceededAt");
    }
  }
  setImmediate(() => { void resumeFromStage2(jobId); });
  return { ok: true };
}

export async function regenerateStage1(
  jobId: string,
  userId: string,
  lookStyleId?: string,
): Promise<{ ok: true }> {
  const job = getVideoJob(jobId, userId);
  if (!job) throw new VideoJobError(404, { error: "not_found" });
  if (job.phase !== "stage1_review" && job.phase !== "stage1_no_face_review") {
    throw new VideoJobError(409, { error: "invalid_phase", phase: job.phase });
  }
  if (lookStyleId) {
    const [look] = await db
      .select({ id: lookStylesTable.id })
      .from(lookStylesTable)
      .where(and(eq(lookStylesTable.id, lookStyleId), eq(lookStylesTable.isActive, true)))
      .limit(1);
    if (!look) {
      throw new VideoJobError(400, { error: "unknown_look_style", lookStyleId });
    }
    job.lookStyleId = lookStyleId;
  }
  // Clear stale stage-1 outputs so consumers don't see the previous still.
  job.stylizedStillObjectPath = undefined;
  job.noFaceFallbackUsed = false;
  job.errorCode = undefined;
  job.errorMessage = undefined;
  setPhase(job, "stage1_pulid");
  setImmediate(() => { void runStage1AndContinue(jobId); });
  return { ok: true };
}

export async function proceedWithNoFaceFallback(jobId: string, userId: string): Promise<{ ok: true }> {
  const job = getVideoJob(jobId, userId);
  if (!job) throw new VideoJobError(404, { error: "not_found" });
  if (job.phase !== "stage1_no_face_review") {
    throw new VideoJobError(409, { error: "invalid_phase", phase: job.phase });
  }
  job.noFaceFallbackUsed = true;
  setPhase(job, "stage1_pulid");
  setImmediate(() => { void runStage1FallbackAndContinue(jobId); });
  return { ok: true };
}

export async function cancelVideoJob(jobId: string, userId: string): Promise<{ ok: true; promotedStillObjectPath?: string }> {
  const job = getVideoJob(jobId, userId);
  if (!job) throw new VideoJobError(404, { error: "not_found" });
  if (job.phase === "completed" || job.phase === "failed" || job.phase === "canceled") {
    return { ok: true, promotedStillObjectPath: job.stylizedStillObjectPath };
  }
  setPhase(job, "canceled");
  if (job.videoJobRowId) {
    try {
      await db
        .update(videoJobsTable)
        .set({ status: "failed", errorCode: "canceled", errorMessage: "canceled_by_user" })
        .where(eq(videoJobsTable.id, job.videoJobRowId));
    } catch (err) {
      logger.warn({ err, jobId }, "[videoPipeline] failed to mark canceled row");
    }
  }
  const promoted = job.stylizedStillObjectPath;
  if (promoted) {
    await promoteStillToLibrary(job, promoted);
  }
  return { ok: true, promotedStillObjectPath: promoted };
}

// ─── State helpers ─────────────────────────────────────────────────────────────

function setPhase(job: JobState, phase: Phase, progress?: number): void {
  job.phase = phase;
  job._phaseStartedAt = Date.now();
  if (progress !== undefined) job.progress = progress;
  // Each phase owns its own slice of the global bar (see computeProgress).
  // Clear the fal floor so a leftover value from the previous stage's
  // onQueueUpdate doesn't bleed forward and lock the bar above the new
  // phase's elapsed-time curve.
  job._falProgressFloor = undefined;
  recomputeEta(job);
}

/**
 * Push the in-memory `_falProgressFloor` up — never down. The floor is read
 * by `computeProgress` as `Math.max(elapsedTimeCurve, _falProgressFloor)` so
 * it can only accelerate the bar, never freeze it. Callers translate per-
 * phase signals into global-bar units (0..1) before calling this.
 */
function bumpFalFloor(job: JobState, floor: number): void {
  const current = job._falProgressFloor ?? 0;
  if (floor > current) {
    job._falProgressFloor = Math.min(0.99, floor);
  }
}

function recomputeEta(job: JobState): void {
  let remainingMs = 0;
  const now = Date.now();
  const elapsedInPhase = now - job._phaseStartedAt;
  const stage1Ms = job.sourceMode === "stylize-then-video" ? stage1Ema : 0;
  const stage2Ms = stage2EmaByEngine.get(job.videoEngineId) ?? 30_000;
  const stage3Ms = stage3Ema;
  switch (job.phase) {
    case "queued":
      remainingMs = stage1Ms + stage2Ms + stage3Ms;
      break;
    case "stage1_pulid":
      remainingMs = Math.max(0, stage1Ms - elapsedInPhase) + stage2Ms + stage3Ms;
      break;
    case "stage1_review":
    case "stage1_no_face_review":
      remainingMs = stage2Ms + stage3Ms;
      break;
    case "stage2_video":
      remainingMs = Math.max(0, stage2Ms - elapsedInPhase) + stage3Ms;
      break;
    case "stage2_subtitle":
      remainingMs = Math.max(0, stage3Ms - elapsedInPhase);
      break;
    case "uploading":
      remainingMs = 2_000;
      break;
    default:
      remainingMs = 0;
  }
  job.etaSeconds = Math.round(remainingMs / 1000);
}

function recordPhaseEma(phaseStartedAt: number, kind: "stage1" | "stage2" | "stage3", engineId?: string): void {
  const sample = Date.now() - phaseStartedAt;
  if (sample <= 0) return;
  if (kind === "stage1") {
    stage1Ema = updateEma(stage1Ema, sample);
  } else if (kind === "stage2") {
    if (engineId) {
      const prev = stage2EmaByEngine.get(engineId) ?? 30_000;
      stage2EmaByEngine.set(engineId, updateEma(prev, sample));
    }
  } else {
    stage3Ema = updateEma(stage3Ema, sample);
  }
}

// ─── Stage 1 / 2 / 3 implementations ─────────────────────────────────────────

async function runPipeline(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.sourceMode === "stylize-then-video") {
    setPhase(job, "stage1_pulid", 0.05);
    await runStage1AndContinue(jobId);
    return;
  }
  // Skip stage 1: the supplied image is the still. Still crop it to the
  // chosen aspect + framing so the video matches intent on engines that
  // derive orientation from the source (e.g. Kling). Veo would honour the
  // aspect_ratio param regardless, but cropping keeps every engine consistent.
  job.stylizedStillObjectPath = await cropBypassStillToAspect(job);
  setPhase(job, "stage1_review", 0.30);
  await markCheckpoint(job);
}

/**
 * For the bypass source modes (use-photo-as-is / use-existing-ai-image),
 * crops the supplied still to the job's aspect ratio + framing focus and
 * uploads the result. Returns the original path unchanged when the crop is a
 * no-op (still already at the target ratio with a centred focus) or when any
 * step fails — the pipeline should never hard-fail on framing.
 */
async function cropBypassStillToAspect(job: JobState): Promise<string> {
  try {
    const objectStorage = new ObjectStorageService();
    const normalized = objectStorage.normalizeObjectEntityPath(job.sourceImagePath);
    const file = await objectStorage.getObjectEntityFile(normalized);
    const response = await objectStorage.downloadObject(file, 60);
    const original = Buffer.from(await response.arrayBuffer());

    const cropped = await cropBufferToAspect(
      original,
      job.aspectRatio,
      job.framingFocus ?? { x: 0.5, y: 0.5 },
    );
    // cropBufferToAspect returns the same reference when nothing changed.
    if (cropped === original) return job.sourceImagePath;

    return await objectStorage.uploadObjectBuffer({
      subPath: `video-stills/${job.jobId}-framed.jpg`,
      buffer: cropped,
      contentType: "image/jpeg",
    });
  } catch (err) {
    logger.warn(
      { err, jobId: job.jobId, aspectRatio: job.aspectRatio },
      "[videoPipeline] bypass still crop failed — using uncropped source",
    );
    return job.sourceImagePath;
  }
}

async function markCheckpoint(job: JobState): Promise<void> {
  if (!job.videoJobRowId) return;
  try {
    await db
      .update(videoJobsTable)
      .set({
        checkpointAt: new Date(),
        stylizedStillObjectPath: job.stylizedStillObjectPath ?? null,
      })
      .where(eq(videoJobsTable.id, job.videoJobRowId));
  } catch (err) {
    logger.warn({ err, jobId: job.jobId }, "[videoPipeline] failed to record checkpointAt");
  }
}

async function runStage1AndContinue(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.phase !== "stage1_pulid") {
    job.phase = "stage1_pulid";
  }
  job.stage1Attempts += 1;
  const stage1StartedAt = Date.now();
  try {
    const { stillObjectPath } = await runStage1(job);
    recordPhaseEma(stage1StartedAt, "stage1");

    // Record stage 1 cost regardless of outcome — costs stand even on retry.
    await recordStage1Cost(job);

    if (!stillObjectPath) {
      setPhase(job, "stage1_no_face_review", 0.20);
      return;
    }

    // NSFW classifier — the stylized still must NOT reach the checkpoint UI
    // if it's flagged.
    const decision = await classifyStill(stillObjectPath);
    if (decision === "reject") {
      job.errorCode = "moderation";
      job.errorMessage =
        "We can't preview this image because it was flagged by our safety filters. Please try a different photo or a different look.";
      setPhase(job, "failed", 0);
      await markFailed(job);
      return;
    }

    job.stylizedStillObjectPath = stillObjectPath;
    setPhase(job, "stage1_review", 0.30);
    await markCheckpoint(job);
  } catch (err) {
    logger.error({ err, jobId, factId: job.factId }, "[videoPipeline] stage 1 failed");
    job.errorCode = "stage1_failed";
    job.errorMessage = err instanceof Error ? err.message : "Stage 1 failed";
    setPhase(job, "failed", 0);
    await markFailed(job);
  }
}

async function runStage1(job: JobState): Promise<{ stillObjectPath: string | null }> {
  if (testHooks.runStage1) {
    return testHooks.runStage1(job);
  }
  // Real implementation — fetch the look style's promptSuffix from the DB,
  // download the source image bytes, hand them to the PuLID helper.
  let styleSuffix: string | undefined;
  if (job.lookStyleId) {
    try {
      const [row] = await db
        .select({ promptSuffixReference: lookStylesTable.promptSuffixReference })
        .from(lookStylesTable)
        .where(eq(lookStylesTable.id, job.lookStyleId))
        .limit(1);
      styleSuffix = row?.promptSuffixReference || undefined;
    } catch (err) {
      logger.warn({ err, lookStyleId: job.lookStyleId }, "[videoPipeline] failed to fetch look style suffix");
    }
  }

  const objectStorage = new ObjectStorageService();
  let referenceBuffer: Buffer;
  try {
    const normalized = objectStorage.normalizeObjectEntityPath(job.sourceImagePath);
    const file = await objectStorage.getObjectEntityFile(normalized);
    const response = await objectStorage.downloadObject(file, 60);
    referenceBuffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw new Error(`Failed to load source image for PuLID: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Honour the user's chosen aspect ratio + framing: crop the source to the
  // target aspect (drag-to-reposition focus) before stylization, and tell
  // PuLID to generate the still at the matching image_size. The video stage
  // then inherits the still's orientation.
  try {
    referenceBuffer = await cropBufferToAspect(
      referenceBuffer,
      job.aspectRatio,
      job.framingFocus ?? { x: 0.5, y: 0.5 },
    );
  } catch (err) {
    logger.warn(
      { err, jobId: job.jobId, aspectRatio: job.aspectRatio },
      "[videoPipeline] source crop to aspect failed — using uncropped source",
    );
  }
  const imageSize = aspectRatioToPulidImageSize(job.aspectRatio);

  try {
    const path = await generateAiMemeBackgroundFromReference(
      job.factId,
      "",
      referenceBuffer,
      "neutral",
      {
        userId: job.userId,
        sourceObjectPath: job.sourceImagePath,
        styleSuffix,
        suppressErrors: false,
        imageSize,
        // Part 2: fal queue/progress events feed _falProgressFloor so the bar
        // reflects actual upstream signals when fal volunteers them. The
        // elapsed-time curve in computeProgress is the floor — fal events
        // only push it higher.
        //
        // Stage 1 budget on the global bar is 0..0.25:
        //   IN_QUEUE      → floor 0.02 (just past the queued baseline)
        //   IN_PROGRESS   → floor 0.13 (~halfway into stage 1's slice)
        //   COMPLETED     → floor 0.22 (the Part 3 milestone bump; the
        //                   stage1_review setPhase that follows then bumps
        //                   us to 0.25 cleanly)
        onProgress: (event) => {
          if (event.phase === "queued") bumpFalFloor(job, 0.02);
          else if (event.phase === "in_progress") bumpFalFloor(job, 0.13);
          else if (event.phase === "completed") bumpFalFloor(job, 0.22);
        },
      },
    );
    return { stillObjectPath: path };
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    // Also inspect the fal.ai error body — PuLID returns HTTP 400 "Bad Request"
    // when no face is detected; the detail lives in err.body, not err.message.
    const bodyStr = (() => {
      try {
        const body = (err as { body?: unknown }).body;
        return body != null ? JSON.stringify(body).toLowerCase() : "";
      } catch {
        return "";
      }
    })();
    const isFaceError =
      msg.includes("no face detected") ||
      msg.includes("facexlib") ||
      msg.includes("face detect") ||
      bodyStr.includes("no face") ||
      bodyStr.includes("face detect") ||
      bodyStr.includes("facexlib") ||
      // PuLID returns HTTP 400 "Bad Request" specifically when it cannot
      // detect a face in the reference image — treat any 400 from this
      // call as a face-detection failure.
      (msg.includes("bad request") && (err as { status?: number }).status === 400);
    if (isFaceError) {
      logger.info({ jobId: job.jobId }, "[videoPipeline] stage 1 no face detected — routing to stage1_no_face_review");
      return { stillObjectPath: null };
    }
    throw err;
  }
}

async function classifyStill(stillObjectPath: string): Promise<"accept" | "reject"> {
  if (testHooks.classifyStill) {
    return testHooks.classifyStill(stillObjectPath);
  }
  try {
    // fal.ai cannot reach internal /objects/... paths — convert to a
    // short-lived signed GCS URL that fal.ai's servers can download.
    const objectStorage = new ObjectStorageService();
    const entitySubPath = stillObjectPath.replace(/^\/objects\//, "");
    const signedUrl = await objectStorage.getObjectEntityDownloadURL(entitySubPath, 300);
    const decision = await classifyAndDecide(signedUrl, { nsfwModeEnabled: false });
    if (decision.outcome === "reject") return "reject";
    return "accept";
  } catch (err) {
    logger.warn({ err, stillObjectPath }, "[videoPipeline] classifyStill error — failing open");
    return "accept";
  }
}

async function runStage1FallbackAndContinue(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  if (testHooks.runStage1Fallback) {
    const { stillObjectPath } = await testHooks.runStage1Fallback(job);
    job.stylizedStillObjectPath = stillObjectPath ?? job.sourceImagePath;
    job.noFaceFallbackUsed = true;
    setPhase(job, "stage2_video", 0.40);
    await resumeFromStage2(jobId);
    return;
  }
  try {
    job.noFaceFallbackUsed = true;
    // No-face fallback: the uploaded photo has no detectable face, so PuLID
    // can't stylize it. Generate a faceless scene still from the fact's scene
    // prompt (text-to-image) so Stage 2 animates a usable image rather than
    // the raw upload. If text-to-image fails (budget/moderation), fall back to
    // promoting the source photo so the job still completes.
    const still = await generateNoFaceStill(job);
    job.stylizedStillObjectPath = still ?? job.sourceImagePath;
    setPhase(job, "stage2_video", 0.40);
    await resumeFromStage2(jobId);
  } catch (err) {
    logger.error({ err, jobId }, "[videoPipeline] no-face fallback failed");
    job.errorCode = "stage1_fallback_failed";
    job.errorMessage = err instanceof Error ? err.message : "Fallback failed";
    setPhase(job, "failed", 0);
    await markFailed(job);
  }
}

/**
 * Generates a faceless scene still via the text-to-image standalone generator
 * for the no-face fallback. Returns null (caller promotes the source photo)
 * if generation fails for any reason — the fallback must never hard-fail.
 */
async function generateNoFaceStill(job: JobState): Promise<string | null> {
  try {
    let factText = job.renderedFactText ?? "";
    if (!factText) {
      const [row] = await db
        .select({ text: factsTable.text })
        .from(factsTable)
        .where(eq(factsTable.id, job.factId))
        .limit(1);
      factText = row?.text ?? "";
    }

    let styleSuffix: string | undefined;
    if (job.lookStyleId) {
      const [row] = await db
        .select({ promptSuffixReference: lookStylesTable.promptSuffixReference })
        .from(lookStylesTable)
        .where(eq(lookStylesTable.id, job.lookStyleId))
        .limit(1);
      styleSuffix = row?.promptSuffixReference || undefined;
    }

    return await generateAiMemeBackgroundStandalone(job.factId, factText, "neutral", {
      userId: job.userId,
      sourceObjectPath: job.sourceImagePath,
      styleSuffix,
    });
  } catch (err) {
    logger.warn(
      { err, jobId: job.jobId },
      "[videoPipeline] no-face text-to-image still failed — promoting source photo",
    );
    return null;
  }
}

async function resumeFromStage2(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.phase !== "stage2_video") setPhase(job, "stage2_video", 0.40);
  const stillPath = job.stylizedStillObjectPath;
  if (!stillPath) {
    job.errorCode = "missing_still";
    job.errorMessage = "Stage 2 cannot start without a stylized still.";
    setPhase(job, "failed", 0);
    await markFailed(job);
    return;
  }

  const stage2StartedAt = Date.now();
  let rawVideoUrl: string;
  try {
    const result = await runStage2(job, stillPath);
    rawVideoUrl = result.videoUrl;
    job.rawVideoUrl = rawVideoUrl;
    recordPhaseEma(stage2StartedAt, "stage2", job.videoEngineId);
    await recordStage2Cost(job);
  } catch (err) {
    logger.error({ err, jobId }, "[videoPipeline] stage 2 failed");
    // fal.ai returns 422 with type "no_media_generated" when the video model
    // refuses to process the input — usually due to content safety, an image
    // incompatible with the selected media type, or a transient model rejection.
    // Route this to the dedicated "moderation" error screen (which shows "Pick a
    // different photo or style and try again" + Go back button) rather than the
    // generic retry screen, since retrying the same image won't help.
    const falErr = err as Record<string, unknown>;
    const isFal422 = typeof falErr["status"] === "number" && falErr["status"] === 422;
    const falBody = falErr["body"] as Record<string, unknown> | undefined;
    const detail = falBody?.["detail"] as Array<Record<string, unknown>> | undefined;
    const isNoMediaGenerated = detail?.[0]?.["type"] === "no_media_generated";
    if (isFal422 && isNoMediaGenerated) {
      job.errorCode = "moderation";
      job.errorMessage = undefined;
    } else if (isFal422) {
      job.errorCode = "stage2_failed";
      job.errorMessage = "The video model couldn't process your image — try a different photo or style, or try again in a moment.";
    } else {
      job.errorCode = "stage2_failed";
      job.errorMessage = err instanceof Error ? err.message : "Video generation failed";
    }
    setPhase(job, "failed", 0);
    await markFailed(job);
    return;
  }

  // Stage 3 — captions
  setPhase(job, "stage2_subtitle", 0.70);
  const stage3StartedAt = Date.now();
  let captionedVideoUrl: string;
  try {
    const out = await runStage3(job, rawVideoUrl);
    captionedVideoUrl = out.captionedVideoUrl;
    recordPhaseEma(stage3StartedAt, "stage3");
    await recordStage3Cost(job);
  } catch (err) {
    logger.error({ err, jobId }, "[videoPipeline] stage 3 failed");
    job.errorCode = "stage3_failed";
    job.errorMessage = err instanceof Error ? err.message : "Caption burn-in failed";
    setPhase(job, "failed", 0);
    await markFailed(job);
    return;
  }

  // Uploading
  setPhase(job, "uploading", 0.90);
  let finalObjectPath: string;
  try {
    finalObjectPath = await uploadFinal(captionedVideoUrl, job.jobId);
    job.finalVideoObjectPath = finalObjectPath;
    if (job.videoJobRowId) {
      try {
        await db
          .update(videoJobsTable)
          .set({
            status: "completed",
            videoUrl: finalObjectPath,
            subtitleEngineId: SUBTITLE_ENGINE_ID,
            completedAt: new Date(),
          })
          .where(eq(videoJobsTable.id, job.videoJobRowId));
      } catch (err) {
        logger.warn({ err, jobId }, "[videoPipeline] failed to update video_jobs row");
      }
    }
  } catch (err) {
    logger.error({ err, jobId }, "[videoPipeline] final upload failed");
    job.errorCode = "upload_failed";
    job.errorMessage = err instanceof Error ? err.message : "Final upload failed";
    setPhase(job, "failed", 0);
    await markFailed(job);
    return;
  }

  // Insert meme row via the shared creator.
  try {
    const meme = await createMemeRecord({
      userId: job.userId,
      factId: job.factId,
      imageSource: {
        type: "video",
        videoJobId: job.videoJobRowId ?? 0,
        videoObjectPath: finalObjectPath,
        stillObjectPath: stillPath,
        lookStyleId: job.lookStyleId ?? undefined,
        motionPresetId: job.motionPresetId ?? undefined,
      },
      aspectRatio: job.aspectRatio,
      name: job.name ?? undefined,
      pronouns: (job.pronouns as never) ?? undefined,
      // Makes createMemeRecord's own `imageTransform === "pulid" && !canPulid`
      // gate reachable for this path — without this, that gate never fires
      // for a video's underlying image no matter what stylized it. The
      // `startVideoJob`-time check above already refuses an unentitled
      // submission; this is the same decision, recorded on the persisted row.
      imageTransform: job.sourceMode === "stylize-then-video" ? "pulid" : undefined,
      // Read back, never re-resolved. This runs long after submission; calling
      // the resolver here would answer against whatever the grid says NOW,
      // which is precisely what the snapshot exists to prevent.
      decisions: {
        meme_private_visibility: decisionFromSnapshot(job._authorizationSnapshot, "meme_private_visibility"),
        meme_rate_limit_high: decisionFromSnapshot(job._authorizationSnapshot, "meme_rate_limit_high"),
        meme_pulid_stylize: decisionFromSnapshot(job._authorizationSnapshot, "meme_pulid_stylize"),
      },
    });
    job.memeId = meme.memeId;
    job.permalinkUrl = meme.permalinkUrl;
    setPhase(job, "completed", 1.0);
  } catch (err) {
    logger.error({ err, jobId }, "[videoPipeline] createMemeRecord failed");
    job.errorCode = "meme_record_failed";
    job.errorMessage = err instanceof Error ? err.message : "Failed to persist meme";
    setPhase(job, "failed", 0);
    await markFailed(job);
  }
}

async function runStage2(job: JobState, stillObjectPath: string): Promise<{ videoUrl: string }> {
  if (testHooks.runStage2) {
    return testHooks.runStage2(job, stillObjectPath);
  }
  // Resolve the engine row + look up motion preset for the prompt text.
  const engine = await loadEngine(job.videoEngineId);
  if (!engine) throw new Error(`Engine ${job.videoEngineId} not found`);

  // A user-supplied custom prompt is a manual override: use it verbatim and
  // skip the generated direction entirely.
  const customPrompt = job.customModePrompt?.trim() ?? "";

  // Convert /objects path → fal CDN URL. Done up front because the motion
  // generator needs to SEE this still (image-to-video direction is grounded in
  // what's actually in the frame), and the engine call needs the same URL.
  const objectStorage = new ObjectStorageService();
  const normalized = objectStorage.normalizeObjectEntityPath(stillObjectPath);
  const file = await objectStorage.getObjectEntityFile(normalized);
  const response = await objectStorage.downloadObject(file, 60);
  const bytes = Buffer.from(await response.arrayBuffer());
  const { fal, ensureFalConfigured } = await import("./falClient");
  ensureFalConfigured();
  const cdnUrl = await fal.storage.upload(
    new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
    { lifecycle: { expiresIn: "1h" } },
  );

  let motionPrompt: string;
  if (customPrompt) {
    motionPrompt = customPrompt;
  } else {
    // Resolve the motion preset (camera/movement) text.
    let presetPrompt = "";
    if (job.motionPresetId) {
      try {
        const [row] = await db
          .select({ motionPrompt: motionPresetsTable.motionPrompt })
          .from(motionPresetsTable)
          .where(eq(motionPresetsTable.id, job.motionPresetId))
          .limit(1);
        presetPrompt = row?.motionPrompt ?? "";
      } catch (err) {
        logger.warn({ err, motionPresetId: job.motionPresetId }, "[videoPipeline] failed to fetch motion prompt");
      }
    }
    if (!presetPrompt) {
      presetPrompt = "Subtle cinematic motion, dramatic lighting, slow camera push-in, epic atmosphere.";
    }

    // Generate image-grounded motion direction (the model sees the still) and
    // layer it on top of the motion preset. LLM failure is non-fatal — fall
    // back to the preset alone.
    let direction = "";
    try {
      direction = await generateVideoDirection(job.renderedFactText ?? "", cdnUrl);
    } catch (err) {
      logger.warn({ err, factId: job.factId }, "[videoPipeline] video direction generation failed; using motion preset only");
    }

    motionPrompt = direction ? `${direction} ${presetPrompt}` : presetPrompt;
  }

  const pipelineParams: Record<string, unknown> = {
    imageUrl: cdnUrl,
    motionPrompt,
    durationSec: job.durationSec,
    aspectRatio: job.aspectRatio,
    resolution: job.resolution,
    generateAudio: true,
    endUserId: job.userId,
    mode: job.engineMode ?? undefined,
  };

  const augmented = applyAudioHandling(engine, pipelineParams, job.renderedFactText);

  let falInput: Record<string, unknown>;
  try {
    falInput = buildEngineInput(engine, augmented);
  } catch (err) {
    if (err instanceof MissingRequiredParamError) {
      throw new Error(`Engine ${engine.id} param error: ${err.message}`);
    }
    throw err;
  }

  // Part 2: feed fal queue/progress signals into the bar floor. Stage 2's
  // global-bar slice depends on whether stage 1 ran. Stylize-then-video
  // occupies 0.25..0.85; the bypass paths get 0..0.85.
  //   IN_QUEUE      → 5% into the slice
  //   IN_PROGRESS   → ~halfway into the slice
  //   COMPLETED     → 0.80 (Part 3 milestone bump — just below the
  //                   stage2_subtitle setPhase that follows at 0.85)
  const stage2Base = job.sourceMode === "stylize-then-video" ? 0.25 : 0;
  const stage2Range = job.sourceMode === "stylize-then-video" ? 0.60 : 0.85;
  const result = await fal.subscribe(engine.endpointId, {
    input: falInput,
    logs: false,
    onQueueUpdate: (status: { status: string; queue_position?: number }) => {
      if (status.status === "IN_QUEUE") {
        bumpFalFloor(job, stage2Base + stage2Range * 0.05);
      } else if (status.status === "IN_PROGRESS") {
        bumpFalFloor(job, stage2Base + stage2Range * 0.50);
      } else if (status.status === "COMPLETED") {
        bumpFalFloor(job, 0.80);
      }
    },
  }) as { data?: { video?: { url?: string } }; requestId?: string };

  const videoUrl = result?.data?.video?.url;
  if (!videoUrl) throw new Error("Video engine returned no video URL");

  // Best-effort: persist the fal request id for this stage 2 run.
  if (job.videoJobRowId && result.requestId) {
    try {
      await db
        .update(videoJobsTable)
        .set({ falRequestId: result.requestId, motionPrompt })
        .where(eq(videoJobsTable.id, job.videoJobRowId));
    } catch (err) {
      logger.warn({ err }, "[videoPipeline] failed to persist stage 2 fal request id");
    }
  }

  return { videoUrl };
}

async function runStage3(job: JobState, videoUrl: string): Promise<{ captionedVideoUrl: string }> {
  if (testHooks.runStage3) {
    return testHooks.runStage3(videoUrl);
  }
  // Part 2: Stage 3's slice of the global bar is 0.85..0.95.
  //   IN_QUEUE      → 0.86
  //   IN_PROGRESS   → 0.91 (~halfway into the slice)
  //   COMPLETED     → 0.94 (Part 3 milestone bump — the uploading
  //                   setPhase that follows then lifts us to 0.97)
  return addCaptionsToVideo({
    videoUrl,
    onProgress: (event) => {
      if (event.phase === "queued") bumpFalFloor(job, 0.86);
      else if (event.phase === "in_progress") bumpFalFloor(job, 0.91);
      else if (event.phase === "completed") bumpFalFloor(job, 0.94);
    },
  });
}

async function uploadFinal(captionedUrl: string, jobId: string): Promise<string> {
  if (testHooks.uploadFinal) {
    return testHooks.uploadFinal(captionedUrl, jobId);
  }
  const res = await fetch(captionedUrl);
  if (!res.ok) {
    throw new Error(`Failed to download captioned video from fal: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const objectStorage = new ObjectStorageService();
  const hash = createHash("sha256").update(jobId).digest("hex").slice(0, 8);
  const subPath = `video-memes/${hash}/${jobId}.mp4`;
  const objectPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer,
    contentType: "video/mp4",
  });
  try {
    await objectStorage.trySetObjectEntityAclPolicy(objectPath, {
      owner: "system",
      visibility: "public",
    });
  } catch (err) {
    logger.warn({ err, objectPath }, "[videoPipeline] failed to set ACL on final video");
  }
  return objectPath;
}

// ─── Cost recording / persistence ────────────────────────────────────────────

async function recordStage1Cost(job: JobState): Promise<void> {
  let cost = STAGE1_FALLBACK_COST;
  try {
    const engine = await loadEngine(PULID_IMAGE_ENGINE_ID);
    if (engine) {
      cost = engineNumeric(engine.estimatedCostUsdPerCall, STAGE1_FALLBACK_COST);
    }
  } catch (err) {
    logger.warn({ err }, "[videoPipeline] failed to load PuLID engine for stage 1 cost");
  }
  job.stage1CostUsd = (job.stage1CostUsd ?? 0) + cost;
  if (job.videoJobRowId) {
    try {
      await db
        .update(videoJobsTable)
        .set({ stage1CostUsd: job.stage1CostUsd.toFixed(6) })
        .where(eq(videoJobsTable.id, job.videoJobRowId));
    } catch (err) {
      logger.warn({ err }, "[videoPipeline] failed to persist stage1 cost on row");
    }
  }
  try {
    await recordCost({
      userId: job.userId,
      jobType: "image",
      endpointId: "fal-ai/flux-pulid",
      unitPriceAtCreation: cost,
      billingUnits: 1,
      computedCostUsd: cost,
      pricingFetchedAt: new Date(),
      jobReferenceId: `videoJob_${job.jobId}_stage1_${job.stage1Attempts}`,
    });
  } catch (err) {
    logger.warn({ err, jobId: job.jobId }, "[videoPipeline] recordStage1Cost ledger failed");
  }
}

async function recordStage2Cost(job: JobState): Promise<void> {
  const engine = await loadEngine(job.videoEngineId);
  const fallbackPerSec = engine
    ? engineNumeric(engine.estimatedCostUsdPerSecond, 0.05)
    : 0.05;
  let cost = fallbackPerSec * job.durationSec;
  try {
    if (!engine) throw new Error("engine missing");
    const price = await getCachedPrice(engine.endpointId);
    const dims = resolveVideoDimensions(ASPECT_RATIO_TO_FAL[job.aspectRatio], job.resolution);
    const { costUsd } = computeVideoCost(
      { width: dims.width, height: dims.height, fps: 24, durationSeconds: job.durationSec },
      price,
    );
    cost = costUsd;
    job.stage2CostUsd = cost;
    await recordCost({
      userId: job.userId,
      jobType: "video",
      endpointId: engine.endpointId,
      unitPriceAtCreation: price.unitPrice,
      billingUnits: (dims.width * dims.height * 24 * job.durationSec) / 1024,
      computedCostUsd: cost,
      pricingFetchedAt: price.fetchedAt,
      jobReferenceId: `videoJob_${job.jobId}_stage2`,
    });
  } catch (err) {
    logger.warn({ err, engineId: job.videoEngineId }, "[videoPipeline] stage2 pricing fetch failed — using fallback");
    job.stage2CostUsd = cost;
    if (engine) {
      try {
        await recordCost({
          userId: job.userId,
          jobType: "video",
          endpointId: engine.endpointId,
          unitPriceAtCreation: cost,
          billingUnits: 1,
          computedCostUsd: cost,
          pricingFetchedAt: new Date(),
          jobReferenceId: `videoJob_${job.jobId}_stage2`,
        });
      } catch (recErr) {
        logger.warn({ err: recErr }, "[videoPipeline] recordCost stage2 failed");
      }
    }
  }
  if (job.videoJobRowId && job.stage2CostUsd != null) {
    try {
      await db
        .update(videoJobsTable)
        .set({ stage2CostUsd: job.stage2CostUsd.toFixed(6) })
        .where(eq(videoJobsTable.id, job.videoJobRowId));
    } catch (err) {
      logger.warn({ err }, "[videoPipeline] failed to persist stage2 cost on row");
    }
  }
}

async function recordStage3Cost(job: JobState): Promise<void> {
  let cost = STAGE3_FALLBACK_COST;
  try {
    const engine = await loadEngine(SUBTITLE_ENGINE_ID);
    if (engine) {
      cost = engineNumeric(engine.estimatedCostUsdPerCall, STAGE3_FALLBACK_COST);
    }
  } catch (err) {
    logger.warn({ err }, "[videoPipeline] failed to load subtitle engine for stage 3 cost");
  }
  job.stage3CostUsd = cost;
  if (job.videoJobRowId) {
    try {
      await db
        .update(videoJobsTable)
        .set({ stage3CostUsd: cost.toFixed(6) })
        .where(eq(videoJobsTable.id, job.videoJobRowId));
    } catch (err) {
      logger.warn({ err }, "[videoPipeline] failed to persist stage3 cost on row");
    }
  }
  try {
    await recordCost({
      userId: job.userId,
      jobType: "video",
      endpointId: "fal-ai/workflow-utilities/auto-subtitle",
      unitPriceAtCreation: cost,
      billingUnits: 1,
      computedCostUsd: cost,
      pricingFetchedAt: new Date(),
      jobReferenceId: `videoJob_${job.jobId}_stage3`,
    });
  } catch (err) {
    logger.warn({ err }, "[videoPipeline] recordStage3Cost failed");
  }
}

async function markFailed(job: JobState): Promise<void> {
  if (!job.videoJobRowId) return;
  try {
    await db
      .update(videoJobsTable)
      .set({
        status: "failed",
        errorCode: job.errorCode ?? null,
        errorMessage: job.errorMessage ?? null,
      })
      .where(eq(videoJobsTable.id, job.videoJobRowId));
  } catch (err) {
    logger.warn({ err, jobId: job.jobId }, "[videoPipeline] failed to mark job row failed");
  }
}

// ─── Promote-still on cancel ─────────────────────────────────────────────────

async function promoteStillToLibrary(job: JobState, stillPath: string): Promise<void> {
  try {
    const existing = await db
      .select({ objectPath: uploadImageMetadataTable.objectPath })
      .from(uploadImageMetadataTable)
      .where(
        and(
          eq(uploadImageMetadataTable.objectPath, stillPath),
          eq(uploadImageMetadataTable.userId, job.userId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      try {
        await db.insert(uploadImageMetadataTable).values({
          objectPath: stillPath,
          width: 1024,
          height: 1024,
          isLowRes: false,
          fileSizeBytes: 0,
          userId: job.userId,
          transform: "pulid",
          sourceObjectPath: job.sourceImagePath,
          factId: job.factId,
        });
      } catch (insertErr) {
        logger.warn({ err: insertErr, stillPath }, "[videoPipeline] failed to insert promoted still metadata");
      }
    }
  } catch (err) {
    logger.warn({ err, stillPath }, "[videoPipeline] promoteStillToLibrary failed");
  }
}
