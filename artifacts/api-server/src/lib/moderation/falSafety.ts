/**
 * Layer 2 — fal.ai built-in safety controls.
 *
 *   Request side:  call `applyFalSafetyTolerance(input, model)` to set
 *                  the appropriate `safety_tolerance` field. Only models
 *                  whose schemas accept the field are touched; others are
 *                  passed through unchanged.
 *   Response side: call `assertNoFalNsfwConcepts(result, ctx)` to check
 *                  for `has_nsfw_concepts: true` (and the equivalent shape
 *                  for video models). Throws {@link FalSafetyTriggeredError}.
 *
 * The PuLID model has historically not exposed `safety_tolerance`; we
 * therefore only set it on FLUX text-to-image variants where the field
 * is documented. The whitelist below is conservative — better to skip a
 * field than 422 fal.ai's input validator.
 */

import { getConfigString } from "../adminConfig";

/** Fal.ai endpoints whose published input schema accepts `safety_tolerance`. */
const SAFETY_TOLERANCE_MODELS = new Set<string>([
  "fal-ai/flux-pro",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/flux-pro/v1.1-ultra",
]);

export function modelAcceptsSafetyTolerance(model: string): boolean {
  return SAFETY_TOLERANCE_MODELS.has(model);
}

export async function applyFalSafetyTolerance(
  input: Record<string, unknown>,
  model: string,
): Promise<void> {
  if (!modelAcceptsSafetyTolerance(model)) return;
  if (input["safety_tolerance"] != null && input["safety_tolerance"] !== "") return; // caller-set wins
  const value = await getConfigString("fal_safety_tolerance_pulid", "1");
  input["safety_tolerance"] = value;
}

export class FalSafetyTriggeredError extends Error {
  constructor(public readonly raw: unknown, public readonly model: string) {
    super(`fal.ai flagged the generation as NSFW (${model})`);
    this.name = "FalSafetyTriggeredError";
  }
}

/**
 * Inspect a fal.ai response for built-in NSFW flags. Throws when any image
 * in the result is flagged. The shapes we recognise:
 *
 *   - text-to-image:  data.has_nsfw_concepts: boolean[]      (one bool per image)
 *   - text-to-image:  data.images[i].has_nsfw_concepts:bool  (legacy)
 *   - video:          data.has_nsfw_concepts:boolean
 */
export function assertNoFalNsfwConcepts(result: unknown, model: string): void {
  if (result == null || typeof result !== "object") return;
  const r = result as Record<string, unknown>;
  const data = (r["data"] as Record<string, unknown> | undefined) ?? r;

  const top = data["has_nsfw_concepts"];
  if (Array.isArray(top) && top.some((v) => v === true)) {
    throw new FalSafetyTriggeredError(result, model);
  }
  if (typeof top === "boolean" && top) {
    throw new FalSafetyTriggeredError(result, model);
  }

  const images = data["images"];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img && typeof img === "object" && (img as Record<string, unknown>)["has_nsfw_concepts"] === true) {
        throw new FalSafetyTriggeredError(result, model);
      }
    }
  }
}
