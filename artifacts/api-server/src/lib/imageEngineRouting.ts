/**
 * Image engine routing (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* A and B).
 *
 * Which engine draws a render is answered in exactly three places, and this
 * module owns the first two:
 *
 *   - the product's engine per mode: two admin-config keys,
 *     `image_engine_t2i` and `image_engine_i2i` (seeded by migration 0123 to
 *     the engines the worker always used), written by the admin engines
 *     screen's "Set default" for an image engine;
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
import { db } from "@workspace/db";
import { adminConfigTable, type Engine } from "@workspace/db/schema";
import { bustConfigCache, getConfigString } from "./adminConfig";
import { clearEngineCaches, loadEngine } from "./engineInterpreter";

export const IMAGE_ENGINE_CONFIG_KEYS: Readonly<Record<GenerationMode, string>> = {
  t2i: "image_engine_t2i",
  i2i: "image_engine_i2i",
};

/** The engines every release before migration 0123 routed to, by mode. */
const PRE_ROUTING_IMAGE_ENGINE_IDS: Readonly<Record<GenerationMode, string>> = {
  t2i: "nano-banana-2",
  i2i: "nano-banana-2-edit",
};

/** The engine id per mode the product would route a new render to now. */
export type ImageEngineIds = Readonly<Record<GenerationMode, string>>;

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
 * The configured engine ids per mode, unvalidated: what a render would be
 * routed to now. Folded into the moderation hash, so a changed default makes
 * an old attempt read stale. A missing key reads as the seeded value.
 */
export async function currentImageEngineIds(): Promise<ImageEngineIds> {
  const [t2i, i2i] = await Promise.all([
    getConfigString(IMAGE_ENGINE_CONFIG_KEYS.t2i, PRE_ROUTING_IMAGE_ENGINE_IDS.t2i),
    getConfigString(IMAGE_ENGINE_CONFIG_KEYS.i2i, PRE_ROUTING_IMAGE_ENGINE_IDS.i2i),
  ]);
  return { t2i: t2i.trim(), i2i: i2i.trim() };
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

// ─── The one writer ──────────────────────────────────────────────────────────

/** True for the two engine keys, which the generic config route refuses. */
export function isImageEngineConfigKey(key: string): boolean {
  return Object.values(IMAGE_ENGINE_CONFIG_KEYS).includes(key);
}

export const IMAGE_ENGINE_CONFIG_KEY_REFUSAL =
  "The image engine for a render mode is set from the admin engines screen (Set default), which checks the engine can draw that mode.";

/**
 * Make `engineId` the engine for its own mode: validates it, then writes the
 * mode's key (upserting the row if a database lacks it). Returns the mode it
 * now serves. The admin engines screen's "Set default" calls this for an
 * image engine; nothing else writes the keys.
 */
export async function setImageEngineForItsMode(engineId: string): Promise<GenerationMode> {
  clearEngineCaches();
  const engine = await loadEngine(engineId);
  const mode = engine?.imageMode === "t2i" || engine?.imageMode === "i2i" ? engine.imageMode : null;
  if (!mode) throw new ImageEngineRoutingError(engineId, null, "it is not an image engine with a render mode");
  const refusal = imageEngineRefusal(engine, mode);
  if (refusal) throw new ImageEngineRoutingError(engineId, mode, refusal);
  // One upsert: migration 0123 seeds both rows, and a database without them
  // (a test clone) gets one with the same labels.
  await db.insert(adminConfigTable).values({
    key: IMAGE_ENGINE_CONFIG_KEYS[mode],
    value: engineId,
    dataType: "text",
    label: mode === "t2i" ? "Image engine: text-to-image" : "Image engine: reference-photo editing",
    description: "Set from the admin engines screen (Set default).",
    isPublic: false,
  }).onConflictDoUpdate({ target: adminConfigTable.key, set: { value: engineId, updatedAt: new Date() } });
  bustConfigCache();
  return mode;
}
