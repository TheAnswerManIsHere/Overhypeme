import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { fal } from "@fal-ai/client";
import { db, videoJobsTable } from "@workspace/db";
import { eq, and, gte, desc } from "drizzle-orm";

const router: IRouter = Router();

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

const GenerateVideoBody = z.object({
  imageUrl: z.string().url().optional(),
  imageBase64: z.string().optional(),
  factId: z.number().int().positive(),
}).refine(data => data.imageUrl || data.imageBase64, {
  message: "Either imageUrl or imageBase64 must be provided",
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
      status: videoJobsTable.status,
      createdAt: videoJobsTable.createdAt,
    })
    .from(videoJobsTable)
    .where(and(
      eq(videoJobsTable.factId, factId),
      eq(videoJobsTable.status, "completed"),
    ))
    .orderBy(desc(videoJobsTable.createdAt));

  res.json({ videos });
});

router.post("/videos/generate", async (req, res) => {
  const apiKey = process.env.FAL_AI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Video generation is not configured. The FAL_AI_API_KEY environment variable is missing." });
    return;
  }

  const parsed = GenerateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const clientIp = getClientIp(req);
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

  const recentJobs = await db
    .select({ id: videoJobsTable.id })
    .from(videoJobsTable)
    .where(and(
      eq(videoJobsTable.ipAddress, clientIp),
      gte(videoJobsTable.createdAt, windowStart),
    ));

  if (recentJobs.length >= RATE_LIMIT_MAX) {
    res.status(429).json({
      error: "Rate limit exceeded. You have generated 3 videos in the past 24 hours. Please try again later.",
    });
    return;
  }

  fal.config({ credentials: apiKey });

  let imageUrl = parsed.data.imageUrl;

  if (!imageUrl && parsed.data.imageBase64) {
    try {
      const base64Data = parsed.data.imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const blob = new Blob([buffer], { type: "image/jpeg" });
      imageUrl = await fal.storage.upload(blob, { lifecycle: { expiresIn: "1h" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Failed to upload image for processing: ${message}` });
      return;
    }
  }

  const [job] = await db.insert(videoJobsTable).values({
    factId: parsed.data.factId,
    imageUrl: imageUrl!,
    status: "pending",
    ipAddress: clientIp,
  }).returning();

  if (!job) {
    res.status(500).json({ error: "Failed to create video job record." });
    return;
  }

  try {
    const result = await fal.subscribe("fal-ai/kling-video/v2.6/standard/image-to-video", {
      input: {
        image_url: imageUrl,
        prompt: "Epic cinematic motion, dramatic camera movement, high energy and intense atmosphere",
        duration: "5",
        aspect_ratio: "16:9",
      },
      logs: false,
    });

    const output = result.data as { video?: { url?: string } };
    const videoUrl = output?.video?.url;

    if (!videoUrl) {
      await db.update(videoJobsTable)
        .set({ status: "failed" })
        .where(eq(videoJobsTable.id, job.id));
      res.status(500).json({ error: "Video generation completed but no video URL was returned." });
      return;
    }

    const [updated] = await db.update(videoJobsTable)
      .set({ status: "completed", videoUrl })
      .where(eq(videoJobsTable.id, job.id))
      .returning({
        id: videoJobsTable.id,
        factId: videoJobsTable.factId,
        imageUrl: videoJobsTable.imageUrl,
        videoUrl: videoJobsTable.videoUrl,
        status: videoJobsTable.status,
        createdAt: videoJobsTable.createdAt,
      });

    res.json({ videoUrl, id: updated?.id, status: "completed", record: updated ?? null });
  } catch (err) {
    await db.update(videoJobsTable)
      .set({ status: "failed" })
      .where(eq(videoJobsTable.id, job.id));
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Video generation failed: ${message}` });
  }
});

export default router;
