/**
 * The gag a picture is drawn from, as the direct compile takes it (plan
 * `docs/plans/PLAN_GAG_DIRECT_RENDER.md`, *Proposed Design* A and D; Q11: 1).
 *
 * Every surface that draws hands the compiler ONE selected gag's content:
 * its scene, its bubbles and its cast. A render attempt freezes that content
 * (and the gag's id) when it is queued, inside its enrichment snapshot's
 * `visualPromptStrategyOverride` (`gagRenderInput`); the admin preview and a
 * comparison panel take it from the gag they were given. Nothing else about
 * the fact reaches the prompt.
 */
import { castIsCurrent, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import type { DirectCompileArgs } from "./compilers/nanoBanana2";

/** Why a gag's content cannot be drawn as it stands: deterministic, so terminal on a render. */
export class DirectGagInputError extends Error {
  constructor(
    public readonly code: "gag_scene_missing" | "gag_cast_not_current",
    message: string,
  ) {
    super(message);
    this.name = "DirectGagInputError";
  }
}

/**
 * The gag part of the direct compile's input, from one gag's stored content.
 * A gag with no scene cannot be drawn; nor can one whose cast was not read
 * from its scene and bubbles as they stand (every save stores a current cast,
 * `assertGagCast`, and the fold filled every older version, so this is a gag
 * nobody could have saved, never a normal state). Only the entries reach the
 * prompt: the extraction marker never does.
 */
export function directGagInput(
  content: Pick<VisualPromptStrategyOverride, "coreSceneOverride" | "bubbles" | "cast" | "castExtraction"> | null | undefined,
): Pick<DirectCompileArgs, "gag" | "cast"> {
  const scene = content?.coreSceneOverride?.trim() ?? "";
  if (!content || !scene) {
    throw new DirectGagInputError("gag_scene_missing", "the gag has no scene to draw");
  }
  if (!castIsCurrent(content)) {
    throw new DirectGagInputError(
      "gag_cast_not_current",
      "the gag's cast was not read from its scene as it stands; save the gag again so its cast is read",
    );
  }
  return {
    gag: { scene, bubbles: content.bubbles ?? [] },
    cast: (content.cast ?? []).map((c) => ({ label: c.label, description: c.description })),
  };
}

/**
 * What of a gag's content reaches a picture, as one comparable value: its
 * scene, its complete bubbles and its cast entries (never the extraction
 * marker, whose time and version change nothing drawn). The one projection
 * render freshness (`buildScenarioInputHash`), render reuse and the tile
 * (`reviewRenderScenarios.ts`) and approval (`sameRenderedGag`) compare, so
 * the three cannot disagree about whether two contents draw the same picture.
 * Stored keys the direct compile does not read (the eleven retired "More art
 * direction" fields) are left out: they shape nothing since the switch.
 */
export function renderedGagProjection(
  content: Pick<VisualPromptStrategyOverride, "coreSceneOverride" | "bubbles" | "cast"> | null | undefined,
): { scene: string; bubbles: Array<{ type: string; entity: string; text: string }>; cast: Array<{ label: string; description: string }> } | null {
  if (!content) return null;
  return {
    scene: content.coreSceneOverride?.trim() ?? "",
    bubbles: (content.bubbles ?? [])
      .map((b) => ({ type: b.type, entity: b.entity.trim(), text: b.text.trim() }))
      .filter((b) => b.entity && b.text),
    cast: (content.cast ?? []).map((c) => ({ label: c.label.trim(), description: c.description.trim() })),
  };
}
