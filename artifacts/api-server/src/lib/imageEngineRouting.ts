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
import type { Engine } from "./engines/engineRecord";
import { engineById } from "./engineInterpreter";
import { liveRecipeVersionIdsForEngines } from "./imagePrompt/recipeStore";

/**
 * Which kind of look a render asks for: none (the photoreal default) or a
 * chosen look style. The product strategy picks the engine by it
 * (`product-strategy.md`, *Pictures and engines*).
 */
export type LookClass = "photoreal" | "styled";

/** The look class of a resolved style selection: no look is photoreal, a chosen look is styled. */
export function lookClassOfSelection(selection: "default" | "selected"): LookClass {
  return selection === "selected" ? "styled" : "photoreal";
}

/**
 * The engine that draws a render, by look and mode (compiler review, Phase 1,
 * plan `docs/plans/PLAN_COMPILER_REVIEW.md`; this adopts launch Phase 8's
 * photoreal and styled split): GPT Image 2.6 draws photoreal pictures and
 * Nano Banana 2.1 styled ones.
 */
export const IMAGE_ENGINE_IDS: Readonly<Record<LookClass, Readonly<Record<GenerationMode, string>>>> = {
  photoreal: { t2i: "gpt-image-2-6", i2i: "gpt-image-2-6-edit" },
  styled: { t2i: "nano-banana-2-1", i2i: "nano-banana-2-1-edit" },
};

/**
 * The photoreal fallback (plan `docs/plans/PLAN_NB_FALLBACK.md`; David,
 * 2026-11-17, Q12 option 2): when a photoreal engine refuses a render on
 * content grounds, the same render is drawn once on the styled engine of the
 * same mode, Nano Banana 2.1. Styled engines have none, and nor does the
 * fallback engine itself.
 */
export function fallbackEngineIdFor(engineId: string): string | null {
  const mode = (Object.keys(IMAGE_ENGINE_IDS.photoreal) as GenerationMode[])
    .find((m) => IMAGE_ENGINE_IDS.photoreal[m] === engineId);
  return mode ? IMAGE_ENGINE_IDS.styled[mode] : null;
}

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
 * The engine ids per mode for a look class, unvalidated: what a render would
 * be routed to now. Folded into the moderation hash, so a changed engine
 * makes an old attempt read stale. Moderation scenarios render with no look,
 * so they read the photoreal engines.
 */
export async function currentImageEngineIds(lookClass: LookClass = "photoreal"): Promise<ImageEngineIds> {
  const ids = IMAGE_ENGINE_IDS[lookClass];
  return { t2i: ids.t2i, i2i: ids.i2i };
}

/**
 * What a moderation render would use now: the routed engine per mode for its
 * look class (no look: photoreal) and the live prompt recipe version for each
 * (the prompt tuner). The moderation hash reads this, so a promotion for a
 * mode's engine makes its renders stale.
 */
export async function currentRenderRouting(lookClass: LookClass = "photoreal"): Promise<ImageEngineIds> {
  const ids = await currentImageEngineIds(lookClass);
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
  if (!engine.isActive) return "it is inactive";
  if (engine.imageMode !== mode) return `its mode is ${engine.imageMode ?? "unset"}, not ${mode}`;
  if (!engine.sizeVocabulary) return "it declares no size vocabulary, so no request can be built for it";
  return null;
}

/**
 * Resolve the engine for a `mode` render: the override when a caller names
 * one, else the engine set in code for the look class and mode. Throws
 * `ImageEngineRoutingError` rather than falling back to anything.
 */
export async function resolveImageEngine(mode: GenerationMode, override?: string | null, lookClass: LookClass = "photoreal"): Promise<Engine> {
  const engineId = override?.trim() || (await currentImageEngineIds(lookClass))[mode];
  const engine = engineById(engineId);
  const refusal = imageEngineRefusal(engine, mode);
  if (refusal) throw new ImageEngineRoutingError(engineId, mode, refusal);
  return engine!;
}
