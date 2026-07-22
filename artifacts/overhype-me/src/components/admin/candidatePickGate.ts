/**
 * Should "Use as draft" (picking an AI-proposed Visual Concept) be blocked
 * because of unsaved Visual-Strategy edits OTHER than the scene/bubbles a
 * pick would replace? Candidates are validated against the PERSISTED
 * override; picking replaces only `coreSceneOverride` + `bubbles` and
 * preserves everything else — so an unsaved edit to any OTHER field means a
 * pick would land on a base the server never saw the saveability proof
 * against. Scene/bubble-only dirtiness (a previous pick, or typing in the
 * Concept box) stays pickable so switching between ideas is fluid.
 */
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, type VisualPromptStrategyOverride } from "@workspace/api-zod";

/**
 * Should picking be blocked? A MISSING override (draft or server) normalizes
 * to the SAME stripped shape as the empty scaffold `withCoreSceneOverride`/
 * `withBubbles` create the first time a moderator types a Concept or bubble
 * with nothing persisted yet — otherwise that scaffold's `rest` (empty
 * arrays) never equals the server's `null`, and picking would be wrongly
 * blocked on a moderator's very first edit (Codex P2, PR #229).
 *
 * Returns the block-reason copy, or null when picking is allowed.
 */
export function computeCandidatePickBlockedReason(
  draftOverride: VisualPromptStrategyOverride | null | undefined,
  serverOverride: VisualPromptStrategyOverride | null | undefined,
): string | null {
  const strip = (ov: VisualPromptStrategyOverride | null | undefined) => {
    const { coreSceneOverride: _s, bubbles: _b, updatedBy: _by, updatedAt: _at, enabled: _e, ...rest } =
      ov ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
    return rest;
  };
  const draftRest = strip(draftOverride);
  const serverRest = strip(serverOverride);
  if (JSON.stringify(draftRest) === JSON.stringify(serverRest)) return null;
  return "Save or discard your current Visual Strategy changes before using an AI idea — picking applies on top of the saved state.";
}
