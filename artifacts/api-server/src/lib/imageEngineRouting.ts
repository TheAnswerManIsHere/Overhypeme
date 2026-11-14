/**
 * Image engine routing (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* A and B).
 *
 * Which engine draws a render is answered in exactly three places, and this
 * module owns the first two:
 *
 *   - the product's engine per mode: `IMAGE_ENGINE_IDS`, set in code
 *     (decisions.md 2026-11-14, AI call settings live in code). The
 *     `image_engine_t2i` and `image_engine_i2i` config rows migration 0123
 *     seeded are no longer read;
 *   - an explicit override, for a caller that names its engine (the engine
 *     evaluation);
 *   - history: `image_prompt_attempts.actual_image_engine_id`, written once at
 *     construction. Nothing derives a stored attempt's engine from today's
 *     configuration.
 *
 * A selection is validated against the catalogue: an unknown, inactive,
 * archived, retired, non-image or wrong-mode engine is refused, never
 * defaulted.
 */

import type { GenerationMode } from "@workspace/api-zod";
import type { Engine } from "@workspace/db/schema";
import { loadEngine } from "./engineInterpreter";
import { liveRecipeVersionIdsForEngines } from "./imagePrompt/recipeStore";

/**
 * The engine that draws a render, by mode. Dev's configured values on
 * 2026-11-14, read through the connector; the photoreal and styled split
 * (GPT Image 2.6, Nano Banana 2.1) is adopted in launch Phase 8, not here.
 */
export const IMAGE_ENGINE_IDS: Readonly<Record<GenerationMode, string>> = {
  t2i: "nano-banana-2",
  i2i: "nano-banana-2-edit",
};

/** The engines every release before migration 0123 routed to, by mode. */
const PRE_ROUTING_IMAGE_ENGINE_IDS: Readonly<Record<GenerationMode, string>> = {
  t2i: "nano-banana-2",
  i2i: "nano-banana-2-edit",
};

/** The engine id per mode the product would route a new render to now. */
export type ImageEngineIds = Readonly<Record<GenerationMode, string>> & {
  /**
   * The live prompt recipe version for each mode's engine (the prompt tuner;
   * null or absent is the baseline). Folded into the moderation hash only
   * when set, so recipe support alone leaves every existing render current.
   */
  readonly recipeVersions?: Readonly<Partial<Record<GenerationMode, number | null>>>;
};

/**
 * The engine that drew (or will draw) a stored attempt: its recorded column,
 * or, for a null, the engine the release that wrote it used. A null exists
 * only on a row a release older than migration 0123 wrote after 0123's
 * backfill, and such a release routed by mode alone, so this is a fact about
 * those rows, never a default for new ones.
 * DELETE the fallback with the contract migration that makes
 * `actual_image_engine_id` NOT NULL (its pass converts those rows first).
 */
export function attemptImageEngineId(attempt: {
  actualImageEngineId: string | null;
  generationMode: string;
}): string {
  return attempt.actualImageEngineId
    ?? PRE_ROUTING_IMAGE_ENGINE_IDS[attempt.generationMode === "i2i" ? "i2i" : "t2i"];
}

/**
 * The engine ids per mode, unvalidated: what a render would be routed to now.
 * Folded into the moderation hash, so a changed engine makes an old attempt
 * read stale.
 */
export async function currentImageEngineIds(): Promise<ImageEngineIds> {
  return { t2i: IMAGE_ENGINE_IDS.t2i, i2i: IMAGE_ENGINE_IDS.i2i };
}

/**
 * What a moderation render would use now: the routed engine per mode and the
 * live prompt recipe version for each (the prompt tuner). The moderation hash
 * reads this, so a promotion for a mode's engine makes its renders stale.
 */
export async function currentRenderRouting(): Promise<ImageEngineIds> {
  const ids = await currentImageEngineIds();
  const live = await liveRecipeVersionIdsForEngines([ids.t2i, ids.i2i]);
  return { ...ids, recipeVersions: { t2i: live.get(ids.t2i) ?? null, i2i: live.get(ids.i2i) ?? null } };
}

export class ImageEngineRoutingError extends Error {
  readonly code = "image_engine_unavailable";
  constructor(
    readonly engineId: string,
    /** Null when the engine has no render mode to be the default for. */
    readonly mode: GenerationMode | null,
    readonly reason: string,
  ) {
    super(`image engine "${engineId}" cannot draw ${mode ? `a ${mode} render` : "any render"}: ${reason}`);
    this.name = "ImageEngineRoutingError";
  }
}

/**
 * Why `engine` cannot draw a `mode` render, or null when it can. Pure, so the
 * config-write validation and the resolver share one rule.
 */
export function imageEngineRefusal(engine: Engine | null, mode: GenerationMode): string | null {
  if (!engine) return "not in the catalogue";
  if (engine.kind !== "image") return `its kind is ${engine.kind}, not image`;
  if (engine.retired) return "it is retired";
  if (engine.deletedAt) return "it is archived";
  if (!engine.isActive) return "it is inactive";
  if (engine.imageMode !== mode) return `its mode is ${engine.imageMode ?? "unset"}, not ${mode}`;
  if (!engine.sizeVocabulary) return "it declares no size vocabulary, so no request can be built for it";
  return null;
}

/**
 * Resolve the engine for a `mode` render: the override when a caller names
 * one, else the configured engine for the mode. Throws
 * `ImageEngineRoutingError` rather than falling back to anything.
 */
export async function resolveImageEngine(mode: GenerationMode, override?: string | null): Promise<Engine> {
  const engineId = override?.trim() || (await currentImageEngineIds())[mode];
  const engine = await loadEngine(engineId);
  const refusal = imageEngineRefusal(engine, mode);
  if (refusal) throw new ImageEngineRoutingError(engineId, mode, refusal);
  return engine!;
}
