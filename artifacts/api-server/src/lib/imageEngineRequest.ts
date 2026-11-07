/**
 * One image engine call, assembled once for every caller that renders: the
 * moderation and member worker (`imagePromptJobs.ts`) and the launch Phase 8
 * engine comparison (`comparison/runs.ts`). The comparison measures what
 * production would send, so the two build their parameters with one function
 * and read the vendor's answer with another.
 */

import type { GenerationMode } from "@workspace/api-zod";
import type { ImageRequestSettings } from "./imageRequestBuilder";

/**
 * The interpreter parameters for one render, from the endpoint settings the
 * request builder chose. Both callers pass the result to `buildEngineInput`.
 */
export function imageEngineParams(
  requestSettings: ImageRequestSettings,
  args: { generationMode: GenerationMode; promptText: string; aspectRatio: unknown; referenceImageUrl?: string | null },
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    imagePrompt: args.promptText,
    aspectRatio: args.aspectRatio,
    numImages: 1,
    ...requestSettings.sizeParams,
  };
  if (args.generationMode === "i2i" && args.referenceImageUrl) params["referenceImageUrl"] = args.referenceImageUrl;
  return params;
}

/** The first image URL in a fal image response ({ images: [{ url }] }, { image: { url } } or { url }), or "". */
export function extractFirstImageUrl(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  // Nano Banana 2 returns { images: [{ url, ... }] }.
  if (Array.isArray(obj["images"])) {
    const first = obj["images"][0];
    if (first && typeof first === "object" && typeof (first as Record<string, unknown>)["url"] === "string") {
      return (first as Record<string, string>)["url"] ?? "";
    }
  }
  if (typeof obj["image"] === "object" && obj["image"] !== null) {
    const im = obj["image"] as Record<string, unknown>;
    if (typeof im["url"] === "string") return im["url"];
  }
  if (typeof obj["url"] === "string") return obj["url"];
  return "";
}

export async function downloadToBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
