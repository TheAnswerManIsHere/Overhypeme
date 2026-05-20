/**
 * PuLID async job endpoints.
 *
 * The wizard's "Forging your likeness" loading takeover needs a server-driven
 * progress bar. The legacy `/memes/ai/:factId/generate` endpoint blocks for
 * the full ~18s of fal.subscribe — fine for the synchronous studio flow, but
 * the wizard wants intermediate queue + run status to drive a realistic bar.
 *
 *   POST /api/memes/pulid-jobs        → { jobId }; starts generation in background
 *   GET  /api/memes/pulid-jobs/:jobId → { phase, progress, generatedObjectPath?, errorCode? }
 *
 * Job state is held in an in-memory Map with a 10-minute TTL. Single-process
 * assumption: the overhype.me API runs as a single Replit-hosted instance, so
 * we don't need Redis here. If we shard later this becomes a Postgres-backed
 * table.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { customAlphabet } from "nanoid";
import { db } from "@workspace/db";
import { factsTable, usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { requireLegendary } from "../middlewares/tierMiddleware";
import {
  generateAiMemeBackgroundFromReference,
  generateAiMemeBackgroundStandalone,
  isUserAtImageLimit,
  type PulidProgressCallback,
  type AiScenePrompts,
} from "../lib/aiMemePipeline";
import { BudgetExceededError } from "../lib/budgetGate";
import { ModerationRejectedError, GENERIC_REJECT_MESSAGE } from "../lib/moderation/types";
import {
  getPulidExpectedRunMs,
  updatePulidExpectedRunMs,
} from "../lib/pulidExpectedRunMs";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const newJobId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 14);

const JOB_TTL_MS = 10 * 60 * 1000;

/**
 * "no_face_review" is the explicit user-choice gate added in MBFO-4. When
 * PuLID's face detector misses, the job parks in this phase instead of
 * silently falling through to standalone generation, so the wizard can
 * surface a "Try a different photo / Use an abstract image" modal. The
 * client resolves the gate by either DELETE-ing the job or POSTing to
 * /memes/pulid-jobs/:jobId/proceed-with-no-face-fallback.
 */
type Phase = "queued" | "in_progress" | "no_face_review" | "completed" | "failed";
type ErrorCode =
  | "service_unavailable"
  | "budget_exceeded"
  | "no_face"
  | "moderation"
  | "internal";

interface JobState {
  jobId: string;
  userId: string;
  factId: number;
  createdAt: number;
  expiresAt: number;
  phase: Phase;
  queuePosition?: number;
  startedRunAt?: number;
  completedAt?: number;
  expectedRunMs: number;
  generatedObjectPath?: string;
  errorCode?: ErrorCode;
  errorMessage?: string;
  /** True once the no-face fallback (standalone generation) has taken over. */
  isFallback?: boolean;
  /** Inputs preserved so the standalone fallback can be triggered later. */
  factText?: string;
  targetGender?: "male" | "female" | "neutral";
  styleSuffix?: string;
  styleId?: string;
  referenceImagePath?: string;
  existingPrompts?: AiScenePrompts;
}

const jobs = new Map<string, JobState>();

function gc() {
  const now = Date.now();
  for (const [id, state] of jobs.entries()) {
    if (state.expiresAt <= now) jobs.delete(id);
  }
}

function isNoFaceError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const msg = typeof e["message"] === "string" ? e["message"] : "";
  const body = e["body"] && typeof e["body"] === "object"
    ? (e["body"] as Record<string, unknown>)
    : undefined;
  const detail = body && typeof body["detail"] === "string" ? body["detail"] : "";
  return /no.face|face.not.detected|no.faces.detected/i.test(`${msg} ${detail}`);
}

function extractMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const body = e["body"] && typeof e["body"] === "object"
      ? (e["body"] as Record<string, unknown>)
      : undefined;
    if (body && typeof body["detail"] === "string" && body["detail"].trim()) {
      return body["detail"].trim();
    }
    if (typeof e["message"] === "string" && e["message"].trim()) {
      return e["message"].trim();
    }
  }
  return "Unknown error";
}

function computeProgress(state: JobState): number {
  if (state.phase === "completed") return 1;
  if (state.phase === "failed") {
    return state.queuePosition !== undefined ? 0.1 : 0.95;
  }
  if (state.phase === "queued") {
    // Earlier this returned 0.30 for pos=1, which made the bar leap to ~30%
    // before any real work had started. Keep queued progress visibly small
    // (2-6%) so the bar starts near empty and only climbs once we move into
    // in_progress, where elapsed time can actually justify the motion.
    const pos = Math.max(1, state.queuePosition ?? 1);
    return Math.max(0.02, 0.06 - (pos - 1) * 0.01);
  }
  // in_progress — start near where queued left off (~0.08) and asymptote
  // toward 0.95 over `expectedRunMs`.
  const startedAt = state.startedRunAt ?? state.createdAt;
  const elapsed = Date.now() - startedAt;
  const tau = Math.max(1, state.expectedRunMs);
  const asymptotic = 0.08 + 0.87 * (1 - Math.exp(-elapsed / tau));
  return Math.min(0.95, asymptotic);
}

function computeEtaSeconds(state: JobState): number | undefined {
  if (state.phase === "completed" || state.phase === "failed") return 0;
  if (state.phase === "queued") {
    const pos = Math.max(1, state.queuePosition ?? 1);
    return Math.round((pos * state.expectedRunMs + state.expectedRunMs) / 1000);
  }
  const startedAt = state.startedRunAt ?? state.createdAt;
  const elapsed = Date.now() - startedAt;
  return Math.max(1, Math.round((state.expectedRunMs - elapsed) / 1000));
}

async function pronounsToGender(userId: string): Promise<"male" | "female" | "neutral"> {
  try {
    const [row] = await db
      .select({ pronouns: usersTable.pronouns })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    const subj = (row?.pronouns ?? "they/them").toLowerCase().trim().split("/")[0] ?? "they";
    if (subj === "he") return "male";
    if (subj === "she") return "female";
    return "neutral";
  } catch {
    return "neutral";
  }
}

// ─── POST /memes/pulid-jobs ───────────────────────────────────────────────────
router.post("/memes/pulid-jobs", requireLegendary, async (req: Request, res: Response) => {
  gc();
  if (!req.user) {
    res.status(401).json({ error: "auth_required" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const factId = Number(body["factId"]);
  if (!Number.isInteger(factId) || factId <= 0) {
    res.status(400).json({ error: "factId is required" });
    return;
  }

  const referenceImagePath = body["referenceImagePath"];
  if (typeof referenceImagePath !== "string" || !referenceImagePath.startsWith("/objects/")) {
    res.status(400).json({ error: "referenceImagePath must be a string starting with /objects/" });
    return;
  }

  const rawGender = body["targetGender"];
  const targetGender: "male" | "female" | "neutral" =
    rawGender === "male" || rawGender === "female" || rawGender === "neutral"
      ? rawGender
      : await pronounsToGender(req.user.id);

  const rawStyleId = typeof body["styleId"] === "string" ? (body["styleId"] as string) : undefined;
  if (rawStyleId !== undefined) {
    const { IMAGE_STYLE_MAP } = await import("../config/imageStyles.js");
    if (!IMAGE_STYLE_MAP.has(rawStyleId)) {
      res.status(400).json({ error: `Unknown styleId: ${rawStyleId}` });
      return;
    }
  }

  // Storage limit gate — matches /memes/ai/:factId/generate
  if (await isUserAtImageLimit(req.user.id)) {
    res.status(429).json({
      error: "You have reached your image storage limit.",
      limitExceeded: true,
    });
    return;
  }

  // Look up the fact.
  const [fact] = await db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      parentId: factsTable.parentId,
      aiScenePrompts: factsTable.aiScenePrompts,
    })
    .from(factsTable)
    .where(and(eq(factsTable.id, factId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!fact) {
    res.status(404).json({ error: "Fact not found" });
    return;
  }
  if (fact.parentId !== null) {
    res.status(400).json({ error: "AI meme generation only supported on root facts" });
    return;
  }

  // Validate the reference image belongs to this user (or is their profile photo).
  const profileObjectPath = req.user.profileImageUrl?.startsWith("/api/storage")
    ? req.user.profileImageUrl.slice("/api/storage".length)
    : null;
  const isProfileImage = profileObjectPath !== null && referenceImagePath === profileObjectPath;
  if (!isProfileImage) {
    const uploadCheck = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM upload_image_metadata
      WHERE object_path = ${referenceImagePath} AND user_id = ${req.user.id}
    `);
    if (parseInt(uploadCheck.rows[0]?.count ?? "0", 10) === 0) {
      res.status(403).json({ error: "Reference image not found in your uploads." });
      return;
    }
  }

  // Resolve optional style suffix.
  let styleSuffix: string | undefined;
  if (rawStyleId && rawStyleId !== "none") {
    try {
      const { IMAGE_STYLE_MAP } = await import("../config/imageStyles.js");
      const styleDef = IMAGE_STYLE_MAP.get(rawStyleId);
      if (styleDef) styleSuffix = styleDef.promptSuffixReference;
    } catch {
      /* non-fatal */
    }
  }

  const expectedRunMs = await getPulidExpectedRunMs();
  const jobId = newJobId();
  const now = Date.now();
  const state: JobState = {
    jobId,
    userId: req.user.id,
    factId,
    createdAt: now,
    expiresAt: now + JOB_TTL_MS,
    phase: "queued",
    expectedRunMs,
    // Preserve the inputs so the no_face_review proceed handler can fire the
    // standalone generator later without re-validating everything.
    factText: fact.text ?? undefined,
    targetGender,
    styleSuffix,
    styleId: rawStyleId,
    referenceImagePath,
    existingPrompts: fact.aiScenePrompts as AiScenePrompts | undefined,
  };
  jobs.set(jobId, state);

  // Fire-and-forget the generation. Errors are written into the job state.
  const userId = req.user.id;
  const factText = fact.text;
  const existingPrompts = fact.aiScenePrompts as AiScenePrompts | undefined;

  void (async () => {
    try {
      const file = await objectStorageService.getObjectEntityFile(referenceImagePath);
      const [referenceBuffer] = await file.download();

      const onProgress: PulidProgressCallback = (event) => {
        const cur = jobs.get(jobId);
        if (!cur) return;
        if (event.phase === "queued") {
          cur.phase = "queued";
          cur.queuePosition = event.queuePosition;
        } else if (event.phase === "in_progress") {
          if (cur.phase !== "in_progress") {
            cur.phase = "in_progress";
            cur.startedRunAt = Date.now();
          }
          cur.queuePosition = undefined;
        } else if (event.phase === "completed") {
          cur.phase = "in_progress";
        }
      };

      let generatedObjectPath: string | null = null;
      try {
        generatedObjectPath = await generateAiMemeBackgroundFromReference(
          factId,
          factText,
          referenceBuffer,
          targetGender,
          {
            existingPrompts,
            userId,
            sourceObjectPath: referenceImagePath,
            styleSuffix,
            onProgress,
          },
        );
      } catch (refErr) {
        // No face detected → park the job in no_face_review and surface a
        // choice to the user. The platform expects a face on every upload, so
        // a silent fallback would have hidden that signal. The client modal
        // gives the user two paths: pick a different photo (DELETE the job)
        // or render an abstract image from the fact instead (POST .../proceed
        // -with-no-face-fallback).
        if (isNoFaceError(refErr)) {
          logger.warn(
            { err: refErr, jobId, factId, userId },
            "[pulidJobs] no face detected — parking in no_face_review for user decision",
          );
          const cur = jobs.get(jobId);
          if (cur) {
            cur.phase = "no_face_review";
            cur.queuePosition = undefined;
          }
          return; // Wait for client to invoke proceed/delete endpoint.
        } else {
          throw refErr;
        }
      }

      const cur = jobs.get(jobId);
      if (!cur) return;
      cur.phase = "completed";
      cur.completedAt = Date.now();
      cur.generatedObjectPath = generatedObjectPath ?? undefined;

      if (cur.startedRunAt) {
        void updatePulidExpectedRunMs(cur.completedAt - cur.startedRunAt);
      }
    } catch (err) {
      const cur = jobs.get(jobId);
      if (!cur) return;
      cur.phase = "failed";
      cur.completedAt = Date.now();
      if (err instanceof BudgetExceededError) {
        cur.errorCode = "budget_exceeded";
        cur.errorMessage = "BUDGET_EXCEEDED";
      } else if (err instanceof ModerationRejectedError) {
        cur.errorCode = "moderation";
        cur.errorMessage = GENERIC_REJECT_MESSAGE;
      } else if (isNoFaceError(err)) {
        // Both the face attempt AND the no-face fallback failed (or the
        // fallback itself raised a no_face-shaped error from a downstream
        // moderation check). Surface the original error code so the UI can
        // distinguish from a generic service failure.
        cur.errorCode = "no_face";
        cur.errorMessage = extractMessage(err);
      } else {
        cur.errorCode = "service_unavailable";
        cur.errorMessage = extractMessage(err);
        logger.error({ err, jobId }, "[pulidJobs] generation failed");
      }
    }
  })();

  res.json({ jobId });
});

// ─── GET /memes/pulid-jobs/:jobId ────────────────────────────────────────────
router.get("/memes/pulid-jobs/:jobId", async (req: Request, res: Response) => {
  gc();
  if (!req.user) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  const jobId = String(req.params["jobId"] ?? "");
  if (!jobId) {
    res.status(400).json({ error: "jobId required" });
    return;
  }
  const state = jobs.get(jobId);
  if (!state) {
    res.status(404).json({ error: "job_not_found" });
    return;
  }
  if (state.userId !== req.user.id) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  res.json({
    jobId: state.jobId,
    phase: state.phase,
    progress: computeProgress(state),
    etaSeconds: computeEtaSeconds(state),
    queuePosition: state.queuePosition,
    generatedObjectPath: state.generatedObjectPath,
    errorCode: state.errorCode,
    errorMessage: state.errorMessage,
    isFallback: state.isFallback ?? false,
  });
});

// ─── POST /memes/pulid-jobs/:jobId/proceed-with-no-face-fallback ────────────
//
// Called by the wizard's no-face modal when the user chooses "Use an abstract
// image based on the fact." Fires the standalone (no-reference) generator
// using the same fact + style + gender we captured at job-start time. The
// result is persisted with imageTransform = "pulid_fallback_text" by the
// pipeline helper. Valid only while phase = "no_face_review".
router.post(
  "/memes/pulid-jobs/:jobId/proceed-with-no-face-fallback",
  async (req: Request, res: Response) => {
    gc();
    if (!req.user) {
      res.status(401).json({ error: "auth_required" });
      return;
    }
    const jobId = String(req.params["jobId"] ?? "");
    const state = jobs.get(jobId);
    if (!state) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    if (state.userId !== req.user.id) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (state.phase !== "no_face_review") {
      res.status(409).json({ error: "invalid_phase", phase: state.phase });
      return;
    }
    if (!state.factText || !state.targetGender || !state.referenceImagePath) {
      // Belt-and-suspenders: these are populated on job creation; missing them
      // means a server restart cleared the map and the client should retry from scratch.
      res.status(409).json({ error: "job_state_lost" });
      return;
    }

    state.phase = "in_progress";
    state.startedRunAt = Date.now();
    state.queuePosition = undefined;
    state.isFallback = true;

    const localState = state;
    void (async () => {
      try {
        const generatedObjectPath = await generateAiMemeBackgroundStandalone(
          localState.factId,
          localState.factText!,
          localState.targetGender!,
          {
            existingPrompts: localState.existingPrompts,
            userId: localState.userId,
            sourceObjectPath: localState.referenceImagePath!,
            styleSuffix: localState.styleSuffix,
          },
        );
        const cur = jobs.get(jobId);
        if (!cur) return;
        cur.phase = "completed";
        cur.completedAt = Date.now();
        cur.generatedObjectPath = generatedObjectPath ?? undefined;
      } catch (err) {
        const cur = jobs.get(jobId);
        if (!cur) return;
        cur.phase = "failed";
        cur.completedAt = Date.now();
        if (err instanceof BudgetExceededError) {
          cur.errorCode = "budget_exceeded";
          cur.errorMessage = "BUDGET_EXCEEDED";
        } else if (err instanceof ModerationRejectedError) {
          cur.errorCode = "moderation";
          cur.errorMessage = GENERIC_REJECT_MESSAGE;
        } else {
          cur.errorCode = "service_unavailable";
          cur.errorMessage = extractMessage(err);
          logger.error({ err, jobId }, "[pulidJobs] no-face-fallback generation failed");
        }
      }
    })();

    res.json({ ok: true });
  },
);

// ─── DELETE /memes/pulid-jobs/:jobId ────────────────────────────────────────
//
// Cancels a job that is parked in no_face_review (or any other non-terminal
// phase). Used by the wizard's "Try a different photo" path. The cancel is
// best-effort — any in-flight fal call cannot actually be stopped, but the
// job state is marked so subsequent polls return failed/canceled.
router.delete("/memes/pulid-jobs/:jobId", async (req: Request, res: Response) => {
  gc();
  if (!req.user) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  const jobId = String(req.params["jobId"] ?? "");
  const state = jobs.get(jobId);
  if (!state) {
    res.status(404).json({ error: "job_not_found" });
    return;
  }
  if (state.userId !== req.user.id) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  state.phase = "failed";
  state.completedAt = Date.now();
  state.errorCode = "internal";
  state.errorMessage = "canceled_by_user";
  res.json({ ok: true });
});

// ── Test-only hooks ──────────────────────────────────────────────────────────
// Exported so unit tests can inject job state without exercising the full fal
// pipeline. Never reach for these from production code.
export const __testHooks = {
  jobs,
  newJobId,
  computeProgress,
  computeEtaSeconds,
};

export default router;
