import type { Engine } from "@workspace/db/schema";

/**
 * Per-engine voiceover/dialogue routing.
 *
 * Each video engine surfaces dialogue differently:
 *   - "native_lipsync"        — Veo. No dedicated dialogue param in fal's
 *                               current API; the prompt itself drives the
 *                               spoken line + lipsync, so we append a
 *                               voiceover cue to motionPrompt.
 *   - "prompt_cue"            — Grok. Append voiceover cue to motionPrompt.
 *   - "voice_control"         — Kling v3. Populate `dialogueText` so the
 *                               interpreter's `voice_text` mapper picks it up.
 *   - "native_audio_boolean"  — Seedance. Improvises audio from the prompt;
 *                               we still append the voiceover cue as a
 *                               directional hint so the model knows what to
 *                               say. The `generate_audio` boolean is already
 *                               in paramSchema.
 *   - "none"                  — PuLID / utility. No audio surface; unchanged.
 *
 * The function mutates a copy of `params` (never the caller's object) and
 * returns the augmented map. Pass the result to `buildEngineInput`.
 */
export function applyAudioHandling(
  engine: Engine,
  params: Record<string, unknown>,
  dialogueText: string | null,
): Record<string, unknown> {
  // No dialogue → nothing to route. Always return a clone so callers can
  // continue to treat the result as their own to mutate.
  const next: Record<string, unknown> = { ...params };
  const trimmed = typeof dialogueText === "string" ? dialogueText.trim() : "";
  if (!trimmed) return next;

  const cue = `\nVoiceover should say, "${trimmed}"`;
  const basePrompt = typeof next.motionPrompt === "string" ? next.motionPrompt : "";

  switch (engine.audioHandling) {
    case "prompt_cue":
    case "native_lipsync":
    case "native_audio_boolean":
      next.motionPrompt = `${basePrompt}${cue}`;
      return next;

    case "voice_control":
      // Kling: leaves prompt alone, surfaces dialogue via a dedicated param.
      next.dialogueText = trimmed;
      return next;

    case "none":
      return next;

    default:
      // Unknown audioHandling — fail open. Log via the caller's logger if
      // needed; we keep this helper dependency-free of pino so it stays
      // trivially testable.
      return next;
  }
}
