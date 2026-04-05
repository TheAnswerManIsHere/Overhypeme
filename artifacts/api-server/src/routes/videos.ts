import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { fal } from "@fal-ai/client";
import { db, videoJobsTable, usersTable } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { deriveUserRole } from "../lib/userRole.js";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
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
const DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v2.1/standard/image-to-video";

const DEFAULT_VIDEO_PROMPT_SYSTEM =
  'You are a video director. Given an image, write a short cinematic motion prompt (1-2 sentences, max 50 words) describing how to animate the scene for a short video clip. Focus on dramatic, visual motion: camera movement, lighting changes, atmosphere. Describe only the visual action and movement. Respond with only the prompt text, nothing else.';

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

async function generateMotionPrompt(factText: string): Promise<string> {
  try {
    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content:
            'You are a video director. Given a humorous "impossible fact" about a person, write a short cinematic motion prompt (1-2 sentences, max 50 words) describing how to animate this scene for a short video clip. Focus on dramatic, funny, or epic visual motion that matches the joke. Do not include the person\'s name. Describe only the visual action, camera movement, and atmosphere. Respond with only the prompt text, nothing else.',
        },
        { role: "user", content: factText },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text || FALLBACK_PROMPT;
  } catch {
    return FALLBACK_PROMPT;
  }
}

const GenerateVideoBody = z
  .object({
    imageUrl: z.string().optional(),
    imageBase64: z.string().optional(),
    factId: z.number().int().positive(),
    motionPrompt: z.string().max(500).optional(),
    styleId: z.string().optional(),
    videoModel: z.string().max(200).optional(),
  })
  .refine((data) => data.imageUrl || data.imageBase64, {
    message: "Either imageUrl or imageBase64 must be provided",
  });

const GeneratePromptBody = z.object({
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
}).refine((data) => data.imageBase64 || data.imageUrl, {
  message: "Either imageBase64 or imageUrl must be provided",
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

async function fetchPrivateImageAsBase64(imageUrl: string): Promise<string | null> {
  const storagePath = extractStoragePathFromUrl(imageUrl);
  if (!storagePath) return null;
  try {
    const normalized = _objectStorage.normalizeObjectEntityPath(storagePath);
    const file = await _objectStorage.getObjectEntityFile(normalized);
    const response = await _objectStorage.downloadObject(file, 60);
    const buf = Buffer.from(await response.arrayBuffer());
    return `data:image/png;base64,${buf.toString("base64")}`;
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

router.post("/videos/generate-prompt", requireAdmin, async (req, res) => {
  const parsed = GeneratePromptBody.safeParse(req.body);
  if (!parsed.success) {
    console.error("[videos/generate-prompt] Validation failed. Body keys:", Object.keys(req.body ?? {}),
      "imageUrl:", (req.body as Record<string, unknown>)?.imageUrl,
      "hasBase64:", !!(req.body as Record<string, unknown>)?.imageBase64,
      "errors:", JSON.stringify(parsed.error.flatten()));
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const openai = getOpenAIClient();
    const systemPrompt = await getConfigString("video_prompt_system_prompt", DEFAULT_VIDEO_PROMPT_SYSTEM);

    const messages: Parameters<typeof openai.chat.completions.create>[0]["messages"] = [
      { role: "system", content: systemPrompt },
    ];

    if (parsed.data.imageBase64) {
      const base64 = parsed.data.imageBase64.startsWith("data:")
        ? parsed.data.imageBase64
        : `data:image/jpeg;base64,${parsed.data.imageBase64}`;
      messages.push({
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: base64, detail: "low" },
          },
          {
            type: "text",
            text: "Write a cinematic motion prompt for this image.",
          },
        ],
      });
    } else if (parsed.data.imageUrl) {
      const resolved = resolveImageUrl(parsed.data.imageUrl, req)!;
      const base64FromStorage = await fetchPrivateImageAsBase64(resolved);
      const imageUrlForOpenAI = base64FromStorage ?? resolved;
      messages.push({
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: imageUrlForOpenAI, detail: "low" },
          },
          {
            type: "text",
            text: "Write a cinematic motion prompt for this image.",
          },
        ],
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      messages,
    });

    const prompt = completion.choices[0]?.message?.content?.trim() ?? FALLBACK_PROMPT;
    res.json({ prompt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[videos] generate-prompt error:", message);
    res.json({ prompt: FALLBACK_PROMPT });
  }
});

router.get("/videos/:factId", async (req, res) => {
  const factId = parseInt(req.params.factId ?? "", 10);
  if (isNaN(factId) || factId <= 0) {
    res.status(400).json({ error: "Invalid factId" });
    return;
  }

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
      createdAt: videoJobsTable.createdAt,
    })
    .from(videoJobsTable)
    .where(
      and(
        eq(videoJobsTable.factId, factId),
        eq(videoJobsTable.status, "completed"),
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

  if (!isAdmin) {
    const clientIp = getClientIp(req);
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
  // 2. Valid or invalid (resolved) styleId provided → use the style's motionPrompt
  // 3. No styleId at all → LLM-generated prompt (backwards-compatible legacy path)
  let motionPrompt = parsed.data.motionPrompt?.trim() || "";

  if (!motionPrompt) {
    if (resolvedStyle) {
      // Use resolved style's motion prompt (covers both valid and invalid styleId cases)
      motionPrompt = resolvedStyle.motionPrompt;
    } else {
      // Legacy: LLM-generated prompt when no styleId was provided
      const [factRow] = await db
        .select({ text: factsTable.text })
        .from(factsTable)
        .where(eq(factsTable.id, parsed.data.factId))
        .limit(1);

      const factText = factRow?.text ?? "";
      motionPrompt = factText
        ? await generateMotionPrompt(factText)
        : FALLBACK_PROMPT;
    }
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
    })
    .returning();

  if (!job) {
    res.status(500).json({ error: "Failed to create video job record." });
    return;
  }

  const requestedModel = parsed.data.videoModel?.trim();
  const videoModel = requestedModel || await getConfigString("video_model", DEFAULT_VIDEO_MODEL) || DEFAULT_VIDEO_MODEL;
  const videoDuration = await getConfigString("video_duration", "5") || "5";
  const videoAspectRatio = await getConfigString("video_aspect_ratio", "16:9") || "16:9";

  console.log("[videos/generate] Calling fal.subscribe", {
    videoModel,
    videoDuration,
    videoAspectRatio,
    imageUrl: imageUrl?.slice(0, 120),
    motionPromptLen: motionPrompt.length,
  });

  try {
    const result = await fal.subscribe(
      videoModel,
      {
        input: {
          image_url: imageUrl,
          prompt: motionPrompt,
          duration: videoDuration,
          aspect_ratio: videoAspectRatio,
        },
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
    console.error("[videos/generate] fal.subscribe failed", {
      model: videoModel,
      message,
      body: err instanceof Error ? undefined : JSON.stringify(err).slice(0, 500),
    });
    res
      .status(500)
      .json({ error: `Video generation failed: ${message}` });
  }
});

export default router;
