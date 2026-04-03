import { Router, type IRouter } from "express";
import { z } from "zod";
import { fal } from "@fal-ai/client";

const router: IRouter = Router();

const GenerateVideoBody = z.object({
  imageUrl: z.string().url().optional(),
  imageBase64: z.string().optional(),
  factId: z.number().int().positive(),
}).refine(data => data.imageUrl || data.imageBase64, {
  message: "Either imageUrl or imageBase64 must be provided",
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
      res.status(500).json({ error: "Video generation completed but no video URL was returned." });
      return;
    }

    res.json({ videoUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Video generation failed: ${message}` });
  }
});

export default router;
