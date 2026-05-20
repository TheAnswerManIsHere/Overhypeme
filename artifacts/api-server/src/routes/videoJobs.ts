/**
 * /api/memes/video-jobs — async multi-stage video pipeline endpoints.
 *
 * Mounted as a sibling to /api/memes. Auth + Legendary-tier gating mirrors
 * what POST /api/videos/generate enforces today; the pipeline runner
 * (lib/videoPipelineRunner.ts) does the actual work, and the engine row
 * (engines table) is the source of truth for which durations / resolutions /
 * aspect ratios / modes are accepted — never hardcoded here.
 *
 * Endpoints (all six required by the wizard spec):
 *   POST   /memes/video-jobs                                       start
 *   GET    /memes/video-jobs/:jobId                                poll
 *   POST   /memes/video-jobs/:jobId/proceed                        past stage1_review
 *   POST   /memes/video-jobs/:jobId/regenerate                     re-run stage 1
 *   POST   /memes/video-jobs/:jobId/proceed-with-no-face-fallback  past stage1_no_face_review
 *   DELETE /memes/video-jobs/:jobId                                cancel + promote still
 *
 * Auth shape (mirrors pulidJobs.ts): every endpoint hard-fails with 401 when
 * `req.isAuthenticated()` returns false. Ownership checks happen inside the
 * pipeline (`getVideoJob` returns null when the caller doesn't own the row,
 * which the runner surfaces as a 404 — never a 403 — to avoid leaking which
 * jobIds exist).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { deriveUserRole, isAtLeastLegendary } from "../lib/userRole";
import { hasFeature } from "../lib/tierFeatures";
import {
  startVideoJob,
  getVideoJob,
  proceedVideoJob,
  regenerateStage1,
  proceedWithNoFaceFallback,
  cancelVideoJob,
  serializeJobState,
  resolveVideoEngine,
  VideoJobError,
  type SourceMode,
  type AspectRatio,
} from "../lib/videoPipelineRunner";
import { loadDefaultEngine } from "../lib/engineInterpreter";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const StartBody = z.object({
  factId: z.number().int().positive(),
  sourceMode: z.enum(["stylize-then-video", "use-photo-as-is", "use-existing-ai-image"]),
  sourceImagePath: z.string().regex(/^\/objects\//).max(500),
  lookStyleId: z.string().max(64).optional(),
  motionPresetId: z.string().max(64).optional(),
  videoEngineId: z.string().max(64).optional(),
  engineMode: z.string().max(64).optional(),
  customModePrompt: z.string().max(500).optional(),
  lengthSeconds: z.number().int().min(1).max(60),
  resolution: z.string().max(16),
  aspectRatio: z.enum(["landscape", "square", "portrait"]),
  name: z.string().max(50).optional(),
  pronouns: z.string().max(20).optional(),
  renderedFactText: z.string().max(1000).optional(),
});

function handleVideoJobError(err: unknown, res: Response): boolean {
  if (err instanceof VideoJobError) {
    res.status(err.status).json(err.body);
    return true;
  }
  return false;
}

router.post("/memes/video-jobs", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Login required to generate videos." });
    return;
  }
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const dbTier = req.user.membershipTier ?? "unregistered";
  const role = req.user.realUserRole ?? deriveUserRole(dbTier, !!req.user.isRealAdmin);
  const isAdmin = role === "admin";

  if (!isAdmin) {
    // Legendary users are always allowed; below that we additionally check
    // the `video_generation` feature flag in case it's enabled for a lower
    // tier via admin override.
    if (!isAtLeastLegendary(role)) {
      const allowed = await hasFeature(dbTier, "video_generation");
      if (!allowed) {
        res.status(403).json({
          error: "VIDEO_GENERATION_LOCKED",
          message: "Video generation is a Legendary feature. Upgrade your membership to unlock it.",
        });
        return;
      }
    }
  }

  // Resolve engine row first so we can surface engine-shaped validation
  // failures (unknown engine, not-a-video-engine) with a precise 400 before
  // we touch the budget gate. Non-admins get the default; admins can pass
  // an explicit engine id in the body.
  const requestedEngineId =
    isAdmin && parsed.data.videoEngineId ? parsed.data.videoEngineId : undefined;
  try {
    await resolveVideoEngine(requestedEngineId);
  } catch (err) {
    if (handleVideoJobError(err, res)) return;
    throw err;
  }

  try {
    const { jobId } = await startVideoJob({
      userId: req.user.id,
      factId: parsed.data.factId,
      sourceMode: parsed.data.sourceMode as SourceMode,
      sourceImagePath: parsed.data.sourceImagePath,
      lookStyleId: parsed.data.lookStyleId ?? null,
      motionPresetId: parsed.data.motionPresetId ?? null,
      videoEngineId: requestedEngineId,
      engineMode: parsed.data.engineMode ?? null,
      customModePrompt: parsed.data.customModePrompt ?? null,
      durationSec: parsed.data.lengthSeconds,
      resolution: parsed.data.resolution,
      aspectRatio: parsed.data.aspectRatio as AspectRatio,
      name: parsed.data.name ?? null,
      pronouns: parsed.data.pronouns ?? null,
      renderedFactText: parsed.data.renderedFactText ?? null,
    });
    res.status(200).json({ jobId });
  } catch (err) {
    if (handleVideoJobError(err, res)) return;
    logger.error({ err }, "[videoJobs] startVideoJob threw");
    res.status(500).json({ error: "internal_error" });
  }
});

router.get("/memes/video-jobs/:jobId", (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const jobId = String(req.params["jobId"] ?? "");
  const job = getVideoJob(jobId, req.user.id);
  if (!job) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(serializeJobState(job));
});

router.post("/memes/video-jobs/:jobId/proceed", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await proceedVideoJob(String(req.params["jobId"] ?? ""), req.user.id);
    res.json(result);
  } catch (err) {
    if (handleVideoJobError(err, res)) return;
    logger.error({ err }, "[videoJobs] proceed threw");
    res.status(500).json({ error: "internal_error" });
  }
});

const RegenBody = z.object({
  lookStyleId: z.string().max(64).optional(),
}).optional();

router.post("/memes/video-jobs/:jobId/regenerate", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = RegenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await regenerateStage1(
      String(req.params["jobId"] ?? ""),
      req.user.id,
      parsed.data?.lookStyleId,
    );
    res.json(result);
  } catch (err) {
    if (handleVideoJobError(err, res)) return;
    logger.error({ err }, "[videoJobs] regenerate threw");
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/memes/video-jobs/:jobId/proceed-with-no-face-fallback", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await proceedWithNoFaceFallback(
      String(req.params["jobId"] ?? ""),
      req.user.id,
    );
    res.json(result);
  } catch (err) {
    if (handleVideoJobError(err, res)) return;
    logger.error({ err }, "[videoJobs] no-face fallback threw");
    res.status(500).json({ error: "internal_error" });
  }
});

router.delete("/memes/video-jobs/:jobId", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await cancelVideoJob(String(req.params["jobId"] ?? ""), req.user.id);
    res.json(result);
  } catch (err) {
    if (handleVideoJobError(err, res)) return;
    logger.error({ err }, "[videoJobs] cancel threw");
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * Read-only helper for the wizard to introspect the active default engine's
 * allowed-options shape (durations, resolutions, aspect ratios, modes). The
 * wizard uses this to populate its advanced sheet without hardcoding any
 * engine-specific knowledge in the client.
 */
router.get("/memes/video-jobs/_meta/default-engine", async (_req: Request, res: Response) => {
  try {
    const engine = await loadDefaultEngine("video");
    res.json({
      id: engine.id,
      label: engine.label,
      provider: engine.provider,
      allowedDurationsSec: engine.allowedDurationsSec,
      defaultDurationSec: engine.defaultDurationSec,
      allowedResolutions: engine.allowedResolutions,
      defaultResolution: engine.defaultResolution,
      allowedAspectRatios: engine.allowedAspectRatios,
      defaultAspectRatio: engine.defaultAspectRatio,
      supportedModes: engine.supportedModes,
      defaultMode: engine.defaultMode,
      audioHandling: engine.audioHandling,
    });
  } catch (err) {
    logger.error({ err }, "[videoJobs] loadDefaultEngine failed");
    res.status(503).json({ error: "video_engine_not_configured" });
  }
});

export default router;
