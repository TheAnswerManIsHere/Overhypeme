/**
 * The image request builder (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* A2).
 *
 * One mapping from (purpose, aspect, engine) to settings the endpoint itself
 * accepts, so a render's size is never written in one engine's vocabulary and
 * sent to another. Each engine definition declares its size vocabulary; the
 * builder picks, per purpose, the supported option nearest the intent:
 *
 *   - `preview`    the engine's smallest size (moderation and eval test
 *                  renders, which only need to show whether the gag lands);
 *   - `comparison` about one megapixel (the engine evaluation's frozen size);
 *   - `final`      about four megapixels (a member's render).
 *
 * The chosen settings are recorded on the attempt (`request_settings`) and
 * are what costing prices. Replaces `pickRenderResolution`, which was the
 * Nano Banana 2 case of this (0.5K for previews, 2K otherwise).
 */

import type { SizeOption, SizeVocabulary, WizardAspect } from "./engines";

export type ImageRequestPurpose = "preview" | "comparison" | "final";

const TARGET_MEGAPIXELS: Readonly<Record<Exclude<ImageRequestPurpose, "preview">, number>> = {
  comparison: 1,
  final: 4,
};

/** What was sent, recorded on the attempt. */
export interface ImageRequestSettings {
  engineId: string;
  purpose: ImageRequestPurpose;
  aspectRatio: WizardAspect;
  /** Pipeline-level params merged into the call, e.g. `{ resolution: "1K" }`. */
  sizeParams: Record<string, string | number | boolean>;
  megapixels: number;
}

export class ImageRequestBuildError extends Error {
  constructor(readonly engineId: string, reason: string) {
    super(`cannot build an image request for "${engineId}": ${reason}`);
    this.name = "ImageRequestBuildError";
  }
}

function isWizardAspect(v: unknown): v is WizardAspect {
  return v === "landscape" || v === "square" || v === "portrait";
}

/** Distance on a log scale, so 0.5x and 2x the target are equally far. */
function distance(mp: number, target: number): number {
  return Math.abs(Math.log(mp / target));
}

function pick(options: SizeOption[], purpose: ImageRequestPurpose): SizeOption {
  if (purpose === "preview") {
    return options.reduce((a, b) => (b.megapixels < a.megapixels ? b : a));
  }
  const target = TARGET_MEGAPIXELS[purpose];
  // Nearest the target; on a tie, the smaller (cheaper) option.
  return options.reduce((a, b) => {
    const da = distance(a.megapixels, target);
    const db = distance(b.megapixels, target);
    if (db < da) return b;
    if (db === da && b.megapixels < a.megapixels) return b;
    return a;
  });
}

export function buildImageRequestSettings(
  engine: { id: string; sizeVocabulary?: unknown },
  purpose: ImageRequestPurpose,
  aspectRatio: unknown,
): ImageRequestSettings {
  if (!isWizardAspect(aspectRatio)) {
    throw new ImageRequestBuildError(engine.id, `aspect "${String(aspectRatio)}" is not landscape, square or portrait`);
  }
  const vocab = engine.sizeVocabulary as SizeVocabulary | null;
  if (!vocab || !Array.isArray(vocab.options) || vocab.options.length === 0) {
    throw new ImageRequestBuildError(engine.id, "it declares no size vocabulary");
  }
  const candidates = vocab.options.filter((o) => o.aspect === undefined || o.aspect === aspectRatio);
  if (candidates.length === 0) {
    throw new ImageRequestBuildError(engine.id, `no size option serves the ${aspectRatio} aspect`);
  }
  const chosen = pick(candidates, purpose);
  return {
    engineId: engine.id,
    purpose,
    aspectRatio,
    sizeParams: { ...chosen.params },
    megapixels: chosen.megapixels,
  };
}
