/**
 * computeCandidatePickBlockedReason — the pure comparison that decides
 * whether "Use as draft" is blocked because of unsaved Visual-Strategy edits
 * OTHER than the scene/bubbles a pick would replace. Covers the exact
 * regression Codex flagged on PR #229: a moderator's very first edit (typing
 * a Concept or bubble with no persisted override yet) must NOT block
 * picking, because the draft's freshly-scaffolded empty-array shape has to
 * be recognized as equivalent to "nothing persisted", not compared against
 * it as if it were a real diff.
 */
import { describe, it, expect } from "vitest";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import { computeCandidatePickBlockedReason } from "./candidatePickGate";

const OV = (partial: Partial<VisualPromptStrategyOverride> = {}): VisualPromptStrategyOverride => ({
  ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
  ...partial,
});

describe("computeCandidatePickBlockedReason", () => {
  it("never blocks when nothing is persisted and nothing else is drafted (both undefined)", () => {
    expect(computeCandidatePickBlockedReason(undefined, undefined)).toBeNull();
  });

  it("does NOT block on a moderator's first Concept edit — the freshly-scaffolded empty draft vs. no persisted override", () => {
    // withCoreSceneOverride(undefined, "...") produces exactly this shape:
    // EMPTY_VISUAL_STRATEGY_OVERRIDE with coreSceneOverride set and enabled
    // flipped true. The server has NO override at all (undefined/null).
    const freshDraft = OV({ coreSceneOverride: "David rides a duck." });
    expect(computeCandidatePickBlockedReason(freshDraft, undefined)).toBeNull();
    expect(computeCandidatePickBlockedReason(freshDraft, null)).toBeNull();
  });

  it("does NOT block on a first bubble edit either", () => {
    const freshDraft = OV({ bubbles: [{ type: "speech", entity: "subject", text: "Hi." }] });
    expect(computeCandidatePickBlockedReason(freshDraft, undefined)).toBeNull();
  });

  it("does NOT block when draft and server are identical (nothing unsaved)", () => {
    const persisted = OV({ requiredVisualDetails: ["a glowing scoreboard"] });
    expect(computeCandidatePickBlockedReason(persisted, persisted)).toBeNull();
  });

  it("does NOT block on scene/bubble-only dirtiness relative to a real persisted base — a pick replaces exactly those fields", () => {
    const persisted = OV({ requiredVisualDetails: ["a glowing scoreboard"], coreSceneOverride: "old scene" });
    const dirtyScene = OV({ requiredVisualDetails: ["a glowing scoreboard"], coreSceneOverride: "new scene, being typed" });
    expect(computeCandidatePickBlockedReason(dirtyScene, persisted)).toBeNull();
  });

  it("BLOCKS when an unrelated field (e.g. requiredVisualDetails) is unsaved relative to a real persisted base", () => {
    const persisted = OV({ coreSceneOverride: "same scene" });
    const dirtyOther = OV({ coreSceneOverride: "same scene", requiredVisualDetails: ["a new unsaved detail"] });
    const reason = computeCandidatePickBlockedReason(dirtyOther, persisted);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/Save or discard/);
  });

  it("BLOCKS when there IS a persisted override but the draft added an unrelated field with nothing saved yet", () => {
    // The server has a real override (not the empty scaffold); the draft
    // diverges on roleBindings, which a pick would NOT touch.
    const persisted = OV({});
    const dirtyOther = OV({ roleBindings: [{ entity: "the bartender", visualRole: "polishing a glass" }] });
    expect(computeCandidatePickBlockedReason(dirtyOther, persisted)).not.toBeNull();
  });
});
