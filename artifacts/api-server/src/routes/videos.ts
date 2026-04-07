import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { fal } from "@fal-ai/client";
import { db, videoJobsTable, usersTable } from "@workspace/db";
import { eq, and, gte, desc, or } from "drizzle-orm";
import { deriveUserRole } from "../lib/userRole.js";
import { VIDEO_STYLE_MAP } from "../config/videoStyles.js";
import { getConfigString } from "../lib/adminConfig.js";
import { requireAdmin } from "./admin.js";
import { isAdminById } from "./auth.js";
import { getSessionId, getSession } from "../lib/auth.js";
import { ObjectStorageService } from "../lib/objectStorage.js";

const router: IRouter = Router();

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FALLBACK_PROMPT = "Subtle cinematic motion, dramatic lighting, slow camera push-in, epic atmosphere";
const DEFAULT_STYLE_ID = "cinematic";
const DEFAULT_VIDEO_MODEL = "xai/grok-imagine-video/image-to-video";


type VideoModelFamily = "kling" | "veo" | "seedance" | "sora" | "runway" | "luma" | "hailuo" | "minimax" | "pixverse" | "wan" | "ltx" | "cogvideox" | "stablevideo" | "hunyuan" | "grok" | "unknown";

function detectVideoModelFamily(model: string): VideoModelFamily {
  if (model.includes("kling-video")) return "kling";
  if (model.includes("/veo")) return "veo";
  if (model.includes("seedance")) return "seedance";
  if (model.includes("sora-2")) return "sora";
  if (model.includes("/runway")) return "runway";
  if (model.includes("luma-dream-machine")) return "luma";
  if (model.includes("/hailuo")) return "hailuo";
  if (model.includes("/minimax/video")) return "minimax";
  if (model.includes("/pixverse")) return "pixverse";
  if (model.startsWith("fal-ai/wan") || model.includes("/wan/") || model === "fal-ai/wan-i2v") return "wan";
  if (model.includes("/ltx")) return "ltx";
  if (model.includes("cogvideox")) return "cogvideox";
  if (model.includes("stable-video")) return "stablevideo";
  if (model.includes("hunyuan-video")) return "hunyuan";
  if (model.includes("grok-imagine-video")) return "grok";
  return "unknown";
}

interface BuildFalInputOptions {
  modelFamily: VideoModelFamily;
  videoModel: string;
  imageUrl: string;
  motionPrompt: string;
  videoDuration: string;
  videoAspectRatio: string;
  isAdmin: boolean;
  // Existing admin params
  adminCfgScale?: number;
  adminNegativePrompt?: string;
  adminSeed?: number;
  adminResolution?: string;
  adminLoop?: boolean;
  // New admin params
  adminGenerateAudio?: boolean;
  adminAutoFix?: boolean;
  adminSafetyTolerance?: string;
  adminPromptOptimizer?: boolean;
  adminStyle?: string;
  adminEnableSafetyChecker?: boolean;
  adminCameraFixed?: boolean;
  adminMotionBucketId?: number;
  adminCondAug?: number;
  adminFps?: number;
  adminNumFrames?: number;
  adminGuidanceScale?: number;
  adminNumInferenceSteps?: number;
  adminGenerateAudioSwitch?: boolean;
  adminGenerateMultiClipSwitch?: boolean;
  adminThinkingType?: string;
}

function normalizeDurationSuffix(raw: string): string {
  const t = raw.trim();
  return /^\d+$/.test(t) ? `${t}s` : t;
}

function parseDurationNum(raw: string): number {
  const t = raw.trim();
  const m = t.match(/^(\d+)/);
  return m ? parseInt(m[1]!, 10) : NaN;
}

function snapToValid(n: number, valid: number[]): number {
  if (isNaN(n)) return valid[valid.length - 1]!;
  return valid.reduce((a, b) => Math.abs(b - n) < Math.abs(a - n) ? b : a);
}

function buildFalInput(opts: BuildFalInputOptions): Record<string, unknown> {
  const {
    modelFamily, imageUrl, motionPrompt, videoDuration, videoAspectRatio,
    isAdmin,
    adminCfgScale, adminNegativePrompt, adminSeed, adminResolution, adminLoop,
    adminGenerateAudio, adminAutoFix, adminSafetyTolerance, adminPromptOptimizer,
    adminStyle, adminEnableSafetyChecker, adminCameraFixed,
    adminMotionBucketId, adminCondAug, adminFps, adminNumFrames,
    adminGuidanceScale, adminNumInferenceSteps,
    adminGenerateAudioSwitch, adminGenerateMultiClipSwitch, adminThinkingType,
  } = opts;

  // ── Veo family ─────────────────────────────────────────────────────────────
  if (modelFamily === "veo") {
    const model = opts.videoModel;
    const rawDurNum = parseDurationNum(videoDuration);

    let veoDuration: string;
    if (model.includes("veo2")) {
      // Veo 2: only 5s–8s
      const valid = [5, 6, 7, 8];
      veoDuration = `${snapToValid(rawDurNum, valid)}s`;
    } else if (model.includes("/lite/") || model.includes("/fast/")) {
      // Veo 3.1 Lite / Fast: 4s, 6s, 8s
      veoDuration = `${snapToValid(rawDurNum, [4, 6, 8])}s`;
    } else {
      // Veo 3 / Veo 3.1 full: 4s–8s
      veoDuration = `${snapToValid(rawDurNum, [4, 6, 8])}s`;
    }

    const veoSupportedRatios = new Set(["16:9", "9:16", "auto"]);
    const veoAspectRatio = veoSupportedRatios.has(videoAspectRatio) ? videoAspectRatio : "auto";

    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
      duration: veoDuration,
      aspect_ratio: veoAspectRatio,
    };

    if (isAdmin) {
      if (adminNegativePrompt?.trim()) falInput.negative_prompt = adminNegativePrompt.trim();
      if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
      if (adminSeed !== undefined) falInput.seed = adminSeed;
      if (adminGenerateAudio !== undefined) falInput.generate_audio = adminGenerateAudio;
      if (adminAutoFix !== undefined) falInput.auto_fix = adminAutoFix;
      if (adminSafetyTolerance?.trim()) falInput.safety_tolerance = adminSafetyTolerance.trim();
    }

    return falInput;
  }

  // ── Kling family ───────────────────────────────────────────────────────────
  if (modelFamily === "kling") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
      duration: videoDuration,
    };

    if (isAdmin) {
      if (adminCfgScale !== undefined) falInput.cfg_scale = adminCfgScale;
      if (adminNegativePrompt?.trim()) falInput.negative_prompt = adminNegativePrompt.trim();
      if (adminSeed !== undefined) falInput.seed = adminSeed;
    }

    return falInput;
  }

  // ── Seedance family ────────────────────────────────────────────────────────
  if (modelFamily === "seedance") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      if (videoDuration?.trim()) falInput.duration = videoDuration.trim();
      if (videoAspectRatio?.trim()) falInput.aspect_ratio = videoAspectRatio.trim();
      if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
      if (adminSeed !== undefined) falInput.seed = adminSeed;
      if (adminGenerateAudio !== undefined) falInput.generate_audio = adminGenerateAudio;
      if (adminEnableSafetyChecker !== undefined) falInput.enable_safety_checker = adminEnableSafetyChecker;
      if (adminCameraFixed !== undefined) falInput.camera_fixed = adminCameraFixed;
    }

    return falInput;
  }

  // ── Sora 2 ─────────────────────────────────────────────────────────────────
  if (modelFamily === "sora") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      // Sora 2 duration is an integer (4, 8, 12, 16, 20)
      const durNum = parseDurationNum(videoDuration);
      if (!isNaN(durNum)) falInput.duration = snapToValid(durNum, [4, 8, 12, 16, 20]);
      const soraRatios = new Set(["auto", "9:16", "16:9"]);
      if (soraRatios.has(videoAspectRatio)) falInput.aspect_ratio = videoAspectRatio;
      if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
    }

    return falInput;
  }

  // ── Runway family ──────────────────────────────────────────────────────────
  if (modelFamily === "runway") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      if (videoDuration?.trim()) falInput.duration = videoDuration.trim();
      if (adminSeed !== undefined) falInput.seed = adminSeed;
    }

    return falInput;
  }

  // ── Luma Dream Machine family ──────────────────────────────────────────────
  if (modelFamily === "luma") {
    const lumaRatios = new Set(["16:9", "9:16", "4:3", "3:4", "21:9", "9:21"]);
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      // Luma duration uses "Xs" format
      if (videoDuration?.trim()) falInput.duration = normalizeDurationSuffix(videoDuration);
      if (lumaRatios.has(videoAspectRatio)) falInput.aspect_ratio = videoAspectRatio;
      if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
      if (adminLoop !== undefined) falInput.loop = adminLoop;
    }

    return falInput;
  }

  // ── Hailuo (MiniMax) family ────────────────────────────────────────────────
  if (modelFamily === "hailuo") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      // Hailuo 02 uses plain number strings ("6", "10"), not "6s"
      if (videoDuration?.trim()) falInput.duration = videoDuration.replace(/s$/, "").trim();
      if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
      if (adminPromptOptimizer !== undefined) falInput.prompt_optimizer = adminPromptOptimizer;
    }

    return falInput;
  }

  // ── MiniMax Video-01 family ────────────────────────────────────────────────
  if (modelFamily === "minimax") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      if (adminPromptOptimizer !== undefined) falInput.prompt_optimizer = adminPromptOptimizer;
    }

    return falInput;
  }

  // ── PixVerse family ─────────────────────────────────────────────────────────
  if (modelFamily === "pixverse") {
    const isV6 = opts.videoModel.includes("/v6/");
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
      if (adminNegativePrompt?.trim()) falInput.negative_prompt = adminNegativePrompt.trim();
      if (adminStyle?.trim()) falInput.style = adminStyle.trim();
      if (adminSeed !== undefined) falInput.seed = adminSeed;
      if (isV6) {
        // v6: duration is an integer (1–15)
        const durNum = parseDurationNum(videoDuration);
        if (!isNaN(durNum)) falInput.duration = Math.min(15, Math.max(1, durNum));
        if (adminGenerateAudioSwitch !== undefined) falInput.generate_audio_switch = adminGenerateAudioSwitch;
        if (adminGenerateMultiClipSwitch !== undefined) falInput.generate_multi_clip_switch = adminGenerateMultiClipSwitch;
        if (adminThinkingType?.trim()) falInput.thinking_type = adminThinkingType.trim();
      } else {
        // v4.5, v5, v5.5: duration is "5" or "8" (plain string)
        if (videoDuration?.trim()) falInput.duration = videoDuration.replace(/s$/, "").trim();
      }
    }

    return falInput;
  }

  // ── WAN family ─────────────────────────────────────────────────────────────
  if (modelFamily === "wan") {
    const isWanPro = opts.videoModel.includes("wan-pro");
    const isWanI2v = opts.videoModel === "fal-ai/wan-i2v";
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      if (adminNegativePrompt?.trim()) falInput.negative_prompt = adminNegativePrompt.trim();
      if (adminSeed !== undefined) falInput.seed = adminSeed;
      if (!isWanPro && !isWanI2v) {
        // WAN 2.7 and other versions: duration is plain integer string
        if (videoDuration?.trim()) falInput.duration = videoDuration.replace(/s$/, "").trim();
        if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
      }
      if (adminEnableSafetyChecker !== undefined) falInput.enable_safety_checker = adminEnableSafetyChecker;
    }

    return falInput;
  }

  // ── LTX family ─────────────────────────────────────────────────────────────
  if (modelFamily === "ltx") {
    const isLtx2 = opts.videoModel.includes("ltx-2-19b");
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      if (adminNegativePrompt?.trim() && !isLtx2) falInput.negative_prompt = adminNegativePrompt.trim();
      if (adminResolution?.trim() && !isLtx2) falInput.resolution = adminResolution.trim();
      if (adminSeed !== undefined && !isLtx2) falInput.seed = adminSeed;
      if (adminNumFrames !== undefined) falInput.num_frames = adminNumFrames;
      if (adminGuidanceScale !== undefined && isLtx2) falInput.guidance_scale = adminGuidanceScale;
      if (adminGenerateAudio !== undefined && isLtx2) falInput.generate_audio = adminGenerateAudio;
      if (adminFps !== undefined && isLtx2) falInput.fps = adminFps;
    }

    return falInput;
  }

  // ── CogVideoX family ────────────────────────────────────────────────────────
  if (modelFamily === "cogvideox") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      if (adminNegativePrompt?.trim()) falInput.negative_prompt = adminNegativePrompt.trim();
      if (adminSeed !== undefined) falInput.seed = adminSeed;
      if (adminGuidanceScale !== undefined) falInput.guidance_scale = adminGuidanceScale;
      if (adminNumInferenceSteps !== undefined) falInput.num_inference_steps = adminNumInferenceSteps;
    }

    return falInput;
  }

  // ── Stable Video Diffusion ──────────────────────────────────────────────────
  if (modelFamily === "stablevideo") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
    };
    // SVD does not support text prompt as a parameter — omit it

    if (isAdmin) {
      if (adminSeed !== undefined) falInput.seed = adminSeed;
      if (adminMotionBucketId !== undefined) falInput.motion_bucket_id = adminMotionBucketId;
      if (adminCondAug !== undefined) falInput.cond_aug = adminCondAug;
      if (adminFps !== undefined) falInput.fps = adminFps;
    }

    return falInput;
  }

  // ── HunyuanVideo ────────────────────────────────────────────────────────────
  if (modelFamily === "hunyuan") {
    return {
      image_url: imageUrl,
      prompt: motionPrompt,
    };
  }

  // ── Grok Imagine Video (xAI) ────────────────────────────────────────────────
  if (modelFamily === "grok") {
    const falInput: Record<string, unknown> = {
      image_url: imageUrl,
      prompt: motionPrompt,
    };

    if (isAdmin) {
      // Duration is an integer (1–15)
      const durNum = parseDurationNum(videoDuration);
      if (!isNaN(durNum)) falInput.duration = Math.min(15, Math.max(1, durNum));
      const grokRatios = new Set(["auto", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"]);
      if (grokRatios.has(videoAspectRatio)) falInput.aspect_ratio = videoAspectRatio;
      if (adminResolution?.trim()) falInput.resolution = adminResolution.trim();
    }

    return falInput;
  }

  // ── Unknown family — best-effort passthrough ───────────────────────────────
  console.warn("[videos/generate] Unknown model family — sending minimal input", { model: opts.videoModel });
  return {
    image_url: imageUrl,
    prompt: motionPrompt,
  };
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = (raw ?? "").split(",")[0];
    const ip = (first ?? "").trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? "unknown";
}


const GenerateVideoBody = z
  .object({
    imageUrl: z.string().optional(),
    imageBase64: z.string().optional(),
    factId: z.number().int().positive(),
    motionPrompt: z.string().max(500).optional(),
    styleId: z.string().optional(),
    videoModel: z.string().max(200).optional(),
    // Admin-only per-request overrides (core)
    adminDuration: z.string().max(20).optional(),
    adminAspectRatio: z.string().max(50).optional(),
    adminCfgScale: z.number().min(0).max(1).optional(),
    adminNegativePrompt: z.string().max(1000).optional(),
    adminSeed: z.number().int().nonnegative().optional(),
    adminResolution: z.string().max(50).optional(),
    adminLoop: z.boolean().optional(),
    // Admin-only extended params
    adminGenerateAudio: z.boolean().optional(),
    adminAutoFix: z.boolean().optional(),
    adminSafetyTolerance: z.string().max(5).optional(),
    adminPromptOptimizer: z.boolean().optional(),
    adminStyle: z.string().max(50).optional(),
    adminEnableSafetyChecker: z.boolean().optional(),
    adminCameraFixed: z.boolean().optional(),
    adminMotionBucketId: z.number().int().min(1).max(255).optional(),
    adminCondAug: z.number().min(0).max(10).optional(),
    adminFps: z.number().int().min(1).max(100).optional(),
    adminNumFrames: z.number().int().min(9).optional(),
    adminGuidanceScale: z.number().min(0).max(30).optional(),
    adminNumInferenceSteps: z.number().int().min(1).max(100).optional(),
    adminGenerateAudioSwitch: z.boolean().optional(),
    adminGenerateMultiClipSwitch: z.boolean().optional(),
    adminThinkingType: z.string().max(20).optional(),
    // Rendered fact text (with name/pronouns already substituted) for voiceover cue
    renderedFactText: z.string().max(1000).optional(),
    isPrivate: z.boolean().optional(),
  })
  .refine((data) => data.imageUrl || data.imageBase64, {
    message: "Either imageUrl or imageBase64 must be provided",
  });

function resolveImageUrl(raw: string | undefined, req: Request): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.startsWith("/")) {
    const proto = req.get("x-forwarded-proto") || "https";
    const host = req.get("host") || "localhost";
    return `${proto}://${host}${raw}`;
  }
  return raw;
}

const _objectStorage = new ObjectStorageService();

function extractStoragePathFromUrl(imageUrl: string): string | null {
  try {
    const u = new URL(imageUrl);
    if (!u.pathname.includes("/memes/ai-user/image")) return null;
    return u.searchParams.get("storagePath");
  } catch {
    return null;
  }
}

async function uploadPrivateImageToFalCdn(imageUrl: string): Promise<string | null> {
  const storagePath = extractStoragePathFromUrl(imageUrl);
  if (!storagePath) return null;
  try {
    const normalized = _objectStorage.normalizeObjectEntityPath(storagePath);
    const file = await _objectStorage.getObjectEntityFile(normalized);
    const response = await _objectStorage.downloadObject(file, 60);
    const buf = Buffer.from(await response.arrayBuffer());
    const blob = new Blob([buf], { type: "image/png" });
    return await fal.storage.upload(blob, { lifecycle: { expiresIn: "1h" } });
  } catch {
    return null;
  }
}

router.post("/videos/generate-prompt", requireAdmin, (req, res) => {
  const styleId = (req.body as Record<string, unknown>)?.styleId as string | undefined;
  const style = (styleId ? VIDEO_STYLE_MAP.get(styleId) : null) ?? VIDEO_STYLE_MAP.get(DEFAULT_STYLE_ID);
  const prompt = style?.motionPrompt ?? FALLBACK_PROMPT;
  res.json({ prompt });
});

router.get("/videos/:factId", async (req, res) => {
  const factId = parseInt(req.params.factId ?? "", 10);
  if (isNaN(factId) || factId <= 0) {
    res.status(400).json({ error: "Invalid factId" });
    return;
  }

  const clientIp = getClientIp(req);
  const viewerUserId = req.isAuthenticated() ? req.user.id : null;

  const videos = await db
    .select({
      id: videoJobsTable.id,
      factId: videoJobsTable.factId,
      imageUrl: videoJobsTable.imageUrl,
      videoUrl: videoJobsTable.videoUrl,
      motionPrompt: videoJobsTable.motionPrompt,
      styleId: videoJobsTable.styleId,
      falRequestId: videoJobsTable.falRequestId,
      status: videoJobsTable.status,
      isPrivate: videoJobsTable.isPrivate,
      createdAt: videoJobsTable.createdAt,
    })
    .from(videoJobsTable)
    .where(
      and(
        eq(videoJobsTable.factId, factId),
        eq(videoJobsTable.status, "completed"),
        or(
          eq(videoJobsTable.isPrivate, false),
          viewerUserId ? eq(videoJobsTable.userId, viewerUserId) : eq(videoJobsTable.ipAddress, clientIp),
        ),
      ),
    )
    .orderBy(desc(videoJobsTable.createdAt));

  res.json({ videos });
});

router.post("/videos/generate", async (req, res) => {
  const apiKey = process.env.FAL_AI_API_KEY;
  if (!apiKey) {
    res
      .status(503)
      .json({
        error:
          "Video generation is not configured. The FAL_AI_API_KEY environment variable is missing.",
      });
    return;
  }

  const parsed = GenerateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    console.error("[videos/generate] Validation failed. Body keys:", Object.keys(req.body ?? {}),
      "imageUrl:", (req.body as Record<string, unknown>)?.imageUrl,
      "hasBase64:", !!(req.body as Record<string, unknown>)?.imageBase64,
      "factId:", (req.body as Record<string, unknown>)?.factId,
      "errors:", JSON.stringify(parsed.error.flatten()));
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const sid = getSessionId(req);
  const session = sid ? await getSession(sid) : null;
  let isAdmin = false;
  if (req.isAuthenticated()) {
    if (isAdminById(req.user.id) || session?.isAdmin === true) {
      isAdmin = true;
    } else {
      const [dbUser] = await db
        .select({ isAdmin: usersTable.isAdmin, membershipTier: usersTable.membershipTier })
        .from(usersTable)
        .where(and(eq(usersTable.id, req.user.id), eq(usersTable.isActive, true)))
        .limit(1);
      isAdmin = deriveUserRole(dbUser?.membershipTier, dbUser?.isAdmin) === "admin";
    }
  }

  const clientIp = getClientIp(req);

  if (!isAdmin) {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

    const recentJobs = await db
      .select({ id: videoJobsTable.id })
      .from(videoJobsTable)
      .where(
        and(
          eq(videoJobsTable.ipAddress, clientIp),
          gte(videoJobsTable.createdAt, windowStart),
        ),
      );

    if (recentJobs.length >= RATE_LIMIT_MAX) {
      res.status(429).json({
        error:
          "Rate limit exceeded. You have generated 3 videos in the past 24 hours. Please try again later.",
      });
      return;
    }
  }

  fal.config({ credentials: apiKey });

  let imageUrl = resolveImageUrl(parsed.data.imageUrl, req);

  if (imageUrl) {
    const cdnUrl = await uploadPrivateImageToFalCdn(imageUrl);
    if (cdnUrl) imageUrl = cdnUrl;
  }

  if (!imageUrl && parsed.data.imageBase64) {
    try {
      const base64Data = parsed.data.imageBase64.replace(
        /^data:image\/\w+;base64,/,
        "",
      );
      const buffer = Buffer.from(base64Data, "base64");
      const blob = new Blob([buffer], { type: "image/jpeg" });
      imageUrl = await fal.storage.upload(blob, {
        lifecycle: { expiresIn: "1h" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res
        .status(500)
        .json({ error: `Failed to upload image for processing: ${message}` });
      return;
    }
  }

  // Resolve style:
  // - valid styleId → use that style
  // - invalid styleId (unrecognised but provided) → default to "cinematic"
  // - no styleId provided → LLM-generated path (legacy backwards-compat)
  const rawStyleId = parsed.data.styleId?.trim();
  const styleIdProvided = rawStyleId !== undefined && rawStyleId !== "";
  const resolvedStyle =
    VIDEO_STYLE_MAP.get(rawStyleId ?? "") ??
    (styleIdProvided ? VIDEO_STYLE_MAP.get(DEFAULT_STYLE_ID)! : null);
  const styleId = resolvedStyle?.id ?? DEFAULT_STYLE_ID;

  // Determine motion prompt:
  // 1. Explicit manual motionPrompt in request → use it as-is
  // 2. Otherwise → use the resolved style's pre-defined motionPrompt (never calls LLM)
  let motionPrompt = parsed.data.motionPrompt?.trim() || "";

  if (!motionPrompt) {
    const effectiveStyle = resolvedStyle ?? VIDEO_STYLE_MAP.get(DEFAULT_STYLE_ID);
    motionPrompt = effectiveStyle?.motionPrompt ?? FALLBACK_PROMPT;
  }

  const [job] = await db
    .insert(videoJobsTable)
    .values({
      factId: parsed.data.factId,
      imageUrl: imageUrl!,
      motionPrompt,
      styleId,
      status: "pending",
      ipAddress: clientIp,
      userId: req.isAuthenticated() ? req.user.id : null,
      isPrivate: parsed.data.isPrivate ?? false,
    })
    .returning();

  if (!job) {
    res.status(500).json({ error: "Failed to create video job record." });
    return;
  }

  const requestedModel = parsed.data.videoModel?.trim();
  const videoModel = requestedModel || await getConfigString("video_model", DEFAULT_VIDEO_MODEL) || DEFAULT_VIDEO_MODEL;

  // Duration and aspect ratio: admin per-request values take priority, else DB config, else defaults
  const videoDuration = (isAdmin && parsed.data.adminDuration) || await getConfigString("video_duration", "5") || "5";
  const videoAspectRatio = (isAdmin && parsed.data.adminAspectRatio) || await getConfigString("video_aspect_ratio", "16:9") || "16:9";

  // Detect model family for parameter adaptation
  const modelFamily = detectVideoModelFamily(videoModel);
  console.log("[videos/generate] Detected model family", { videoModel, modelFamily });

  // Append voiceover cue to the prompt sent to fal.ai (not stored in DB)
  const renderedFactText = parsed.data.renderedFactText?.trim();
  const falMotionPrompt = renderedFactText
    ? `${motionPrompt}\nVoiceover should say, "${renderedFactText}"`
    : motionPrompt;

  // Build fal.ai input adapted for the detected model family
  const falInput = buildFalInput({
    modelFamily,
    videoModel,
    imageUrl: imageUrl!,
    motionPrompt: falMotionPrompt,
    videoDuration,
    videoAspectRatio,
    isAdmin,
    // Core params
    adminCfgScale: parsed.data.adminCfgScale,
    adminNegativePrompt: parsed.data.adminNegativePrompt,
    adminSeed: parsed.data.adminSeed,
    adminResolution: parsed.data.adminResolution,
    adminLoop: parsed.data.adminLoop,
    // Extended params
    adminGenerateAudio: parsed.data.adminGenerateAudio,
    adminAutoFix: parsed.data.adminAutoFix,
    adminSafetyTolerance: parsed.data.adminSafetyTolerance,
    adminPromptOptimizer: parsed.data.adminPromptOptimizer,
    adminStyle: parsed.data.adminStyle,
    adminEnableSafetyChecker: parsed.data.adminEnableSafetyChecker,
    adminCameraFixed: parsed.data.adminCameraFixed,
    adminMotionBucketId: parsed.data.adminMotionBucketId,
    adminCondAug: parsed.data.adminCondAug,
    adminFps: parsed.data.adminFps,
    adminNumFrames: parsed.data.adminNumFrames,
    adminGuidanceScale: parsed.data.adminGuidanceScale,
    adminNumInferenceSteps: parsed.data.adminNumInferenceSteps,
    adminGenerateAudioSwitch: parsed.data.adminGenerateAudioSwitch,
    adminGenerateMultiClipSwitch: parsed.data.adminGenerateMultiClipSwitch,
    adminThinkingType: parsed.data.adminThinkingType,
  });

  console.log("[videos/generate] Calling fal.subscribe", {
    videoModel,
    modelFamily,
    falInput: { ...falInput, image_url: (falInput.image_url as string)?.slice(0, 120) },
  });

  try {
    const result = await fal.subscribe(
      videoModel,
      {
        input: falInput,
        logs: false,
        headers: {
          "X-Fal-Object-Lifecycle-Preference": JSON.stringify({
            expiration_duration_seconds: null,
          }),
        },
      },
    );

    const falRequestId = result.requestId ?? null;
    const output = result.data as { video?: { url?: string } };
    const videoUrl = output?.video?.url;

    if (!videoUrl) {
      await db
        .update(videoJobsTable)
        .set({ status: "failed", falRequestId })
        .where(eq(videoJobsTable.id, job.id));
      res
        .status(500)
        .json({
          error: "Video generation completed but no video URL was returned.",
        });
      return;
    }

    const [updated] = await db
      .update(videoJobsTable)
      .set({ status: "completed", videoUrl, falRequestId })
      .where(eq(videoJobsTable.id, job.id))
      .returning({
        id: videoJobsTable.id,
        factId: videoJobsTable.factId,
        imageUrl: videoJobsTable.imageUrl,
        videoUrl: videoJobsTable.videoUrl,
        motionPrompt: videoJobsTable.motionPrompt,
        styleId: videoJobsTable.styleId,
        falRequestId: videoJobsTable.falRequestId,
        status: videoJobsTable.status,
        createdAt: videoJobsTable.createdAt,
      });

    res.json({
      videoUrl,
      id: updated?.id,
      status: "completed",
      record: updated ?? null,
    });
  } catch (err) {
    await db
      .update(videoJobsTable)
      .set({ status: "failed" })
      .where(eq(videoJobsTable.id, job.id));
    const message = err instanceof Error ? err.message : "Unknown error";
    // Log all enumerable properties on the error to capture fal.ai error body
    const errDetails: Record<string, unknown> = { message };
    if (err && typeof err === "object") {
      for (const key of Object.keys(err)) {
        try { errDetails[key] = (err as Record<string, unknown>)[key]; } catch { /* skip */ }
      }
      // Also try cause, status, body which may be non-enumerable
      for (const key of ["status", "body", "cause", "statusCode", "detail"]) {
        if (key in (err as object)) errDetails[key] = (err as Record<string, unknown>)[key];
      }
    }
    console.error("[videos/generate] fal.subscribe failed", {
      model: videoModel,
      ...errDetails,
    });
    res
      .status(500)
      .json({ error: `Video generation failed: ${message}` });
  }
});

export default router;
