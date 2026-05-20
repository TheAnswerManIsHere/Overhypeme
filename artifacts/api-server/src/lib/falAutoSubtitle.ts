/**
 * fal.ai auto-subtitle wrapper.
 *
 * Thin wrapper around `fal-ai/workflow-utilities/auto-subtitle`. Caption
 * styling is locked per the wizard spec — the only inputs the caller controls
 * are the source video URL and (optional) overrides for the locked style.
 *
 * Style fields are sent inline to fal — if the spec ever needs them per-engine
 * we can promote them to the engineInterpreter, but for now the four engines
 * we ship use the same brand-locked caption look.
 */

import { fal } from "@fal-ai/client";
import { logger } from "./logger";

// fal-ai/workflow-utilities/auto-subtitle only accepts named colors, not hex.
// Allowed: white, black, red, green, blue, yellow, orange, purple, pink, brown, gray, cyan, magenta.
export const LOCKED_CAPTION_STYLE = {
  font: "Anton",
  font_size: 70,
  font_color: "white",
  highlight_color: "orange",
  stroke_width: 3,
  stroke_color: "black",
  position: "bottom",
  y_offset: 75,
  words_per_subtitle: 1,
  animation: true,
} as const;

export type CaptionStyle = typeof LOCKED_CAPTION_STYLE;

/** Phase signals emitted by fal's queue tracker, normalized for callers. */
export type CaptionsProgressPhase = "queued" | "in_progress" | "completed";
export type CaptionsProgressCallback = (event: { phase: CaptionsProgressPhase; queuePosition?: number }) => void;

export interface AddCaptionsInput {
  videoUrl: string;
  captionStyleOverrides?: Partial<CaptionStyle>;
  /**
   * Optional callback fed fal's `onQueueUpdate` events so the wizard's
   * progress bar can reflect upstream signals while auto-subtitle runs.
   */
  onProgress?: CaptionsProgressCallback;
}

export interface AddCaptionsResult {
  captionedVideoUrl: string;
  requestId: string | null;
}

const AUTO_SUBTITLE_ENDPOINT = "fal-ai/workflow-utilities/auto-subtitle";

function configureFal(): void {
  const apiKey = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
  if (!apiKey) {
    throw new Error("FAL_AI_API_KEY environment variable is not set — auto-subtitle unavailable");
  }
  fal.config({ credentials: apiKey });
}

/**
 * Burns word-by-word animated captions into the video. Returns the fal CDN URL
 * of the captioned MP4 — caller is responsible for downloading and persisting
 * to durable storage (R2/GCS).
 */
export async function addCaptionsToVideo(
  input: AddCaptionsInput,
): Promise<AddCaptionsResult> {
  configureFal();

  const style = { ...LOCKED_CAPTION_STYLE, ...(input.captionStyleOverrides ?? {}) };

  const falInput: Record<string, unknown> = {
    video_url: input.videoUrl,
    ...style,
  };

  logger.info(
    { videoUrl: input.videoUrl.slice(0, 120) },
    "[falAutoSubtitle] calling fal-ai/workflow-utilities/auto-subtitle",
  );

  const onProgress = input.onProgress;
  const result = await fal.subscribe(AUTO_SUBTITLE_ENDPOINT, {
    input: falInput as never,
    logs: false,
    onQueueUpdate: onProgress
      ? (status: { status: string; queue_position?: number }) => {
          if (status.status === "IN_QUEUE") {
            onProgress({ phase: "queued", queuePosition: status.queue_position });
          } else if (status.status === "IN_PROGRESS") {
            onProgress({ phase: "in_progress" });
          } else if (status.status === "COMPLETED") {
            onProgress({ phase: "completed" });
          }
        }
      : undefined,
  }) as { data?: { video?: { url?: string } }; requestId?: string };

  const captionedVideoUrl = result?.data?.video?.url;
  if (!captionedVideoUrl) {
    throw new Error("auto-subtitle returned no video URL");
  }

  return {
    captionedVideoUrl,
    requestId: result.requestId ?? null,
  };
}
