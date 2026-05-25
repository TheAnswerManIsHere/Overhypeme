/**
 * Builds the POST /api/memes/video-jobs body from wizard state.
 *
 * Mirrors the image-flow `saveMemePayload` builder in spirit: take the
 * runtime state + a small set of immutables (factId, viewer name/pronouns)
 * and produce the wire payload.
 *
 * The payload requires a resolved `sourceImagePath` — the caller supplies it
 * after resolving the picked source (primary / library / fresh / ai-styling)
 * to a concrete object path.
 */

import type { AspectRatio } from "../../../types";
import type { VideoSourceMode } from "../../state/wizardStorage";

export interface BuildVideoJobPayloadArgs {
  factId: number;
  sourceMode: VideoSourceMode;
  /** Already-resolved object path (e.g. "/objects/uploads/abc.jpg"). */
  sourceImagePath: string;
  lookStyleId?: string;
  motionPresetId?: string | null;
  videoEngineId?: string;
  engineMode?: string;
  customModePrompt?: string;
  lengthSeconds: number;
  resolution: string;
  aspectRatio: AspectRatio;
  /** Normalized crop focus {x,y} in [0,1]; omitted/centre when not repositioned. */
  framingFocus?: { x: number; y: number } | null;
  name?: string;
  pronouns?: string;
}

export interface VideoJobPayload {
  factId: number;
  sourceMode: VideoSourceMode;
  sourceImagePath: string;
  lookStyleId?: string;
  motionPresetId?: string;
  videoEngineId?: string;
  engineMode?: string;
  customModePrompt?: string;
  lengthSeconds: number;
  resolution: string;
  aspectRatio: AspectRatio;
  framingFocus?: { x: number; y: number };
  name?: string;
  pronouns?: string;
}

export function buildVideoJobPayload(
  args: BuildVideoJobPayloadArgs,
): VideoJobPayload {
  const {
    factId,
    sourceMode,
    sourceImagePath,
    lookStyleId,
    motionPresetId,
    videoEngineId,
    engineMode,
    customModePrompt,
    lengthSeconds,
    resolution,
    aspectRatio,
    framingFocus,
    name,
    pronouns,
  } = args;

  const payload: VideoJobPayload = {
    factId,
    sourceMode,
    sourceImagePath,
    lengthSeconds,
    resolution,
    aspectRatio,
  };

  // Only send a focus point when the user actually moved it off centre — keeps
  // the payload clean and lets the server default to a centre crop.
  if (
    framingFocus &&
    (Math.abs(framingFocus.x - 0.5) > 1e-3 || Math.abs(framingFocus.y - 0.5) > 1e-3)
  ) {
    payload.framingFocus = { x: framingFocus.x, y: framingFocus.y };
  }

  // Look style is only meaningful for the stylize path. For
  // `use-photo-as-is` we never stylize, so the field is omitted entirely.
  if (lookStyleId && sourceMode !== "use-photo-as-is") {
    payload.lookStyleId = lookStyleId;
  }
  if (motionPresetId) payload.motionPresetId = motionPresetId;
  if (videoEngineId) payload.videoEngineId = videoEngineId;
  if (engineMode) payload.engineMode = engineMode;
  // Only send the custom prompt when the engineMode actually opts into it.
  if (engineMode === "custom" && customModePrompt && customModePrompt.trim().length > 0) {
    payload.customModePrompt = customModePrompt.trim();
  }
  if (name && name.trim().length > 0) payload.name = name.trim();
  if (pronouns && pronouns.trim().length > 0) payload.pronouns = pronouns.trim();

  return payload;
}
