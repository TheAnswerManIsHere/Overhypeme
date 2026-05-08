/**
 * Behavior matrix for the Phase-3 meme builder.
 *
 * The (mode, tier, entryFlow) tuple is resolved into a single BehaviorCell
 * object once, at the top of the builder. The rest of the component branches
 * off of that object — never off the raw tuple.
 *
 * Treat this as the source of truth for "what the builder shows, given who
 * is using it and where they came from".
 */

import type {
  Action,
  BehaviorCell,
  EntryFlow,
  HeaderCopyKey,
  Mode,
  Tier,
} from "./types";

function headerKey(entryFlow: EntryFlow, sourceArea: "stock" | "my-image", showStylizeToggle: boolean): HeaderCopyKey {
  if (entryFlow === "remix") return "make-this-your-own";
  if (entryFlow === "cold-permalink") {
    if (showStylizeToggle) return "see-yourself-ai";
    if (sourceArea === "my-image") return "see-with-your-face";
    return "see-with-your-name";
  }
  return "build-your-meme";
}

export function resolveBehavior(
  mode: Mode,
  tier: Tier,
  entryFlow: EntryFlow,
): BehaviorCell {
  // ── Invalid: self-upload requires registration ────────────────────────
  if (mode === "self-upload" && tier === "unregistered") {
    return {
      invalid: true,
      upgradeTo: "registered",
      upgradeReason: "Sign up free to upload your photo",
      visibleActions: [],
      headerCopyKey: "build-your-meme",
      showStylizeToggle: false,
      sourceArea: "my-image",
      showTryAiUpsell: false,
      postSave: "none",
    };
  }

  // ── stock × * (valid for every tier) ──────────────────────────────────
  if (mode === "stock") {
    const visibleActions: Action[] =
      tier === "unregistered"
        ? ["download", "signup-cta"]
        : ["download", "save", "share"];

    const showTryAiUpsell = tier === "legendary";
    const postSave: BehaviorCell["postSave"] =
      tier === "unregistered"
        ? "none"
        : entryFlow === "cold-permalink"
          ? "share"
          : "back-to-fact";

    return {
      invalid: false,
      visibleActions,
      headerCopyKey: headerKey(entryFlow, "stock", false),
      showStylizeToggle: false,
      sourceArea: "stock",
      showTryAiUpsell,
      postSave,
    };
  }

  // ── self-upload × registered/legendary ────────────────────────────────
  // (unregistered already returned above)
  const showStylizeToggle = tier === "legendary";

  const visibleActions: Action[] = ["download", "save", "share"];
  const postSave: BehaviorCell["postSave"] =
    entryFlow === "cold-permalink" ? "share" : "back-to-fact";

  return {
    invalid: false,
    visibleActions,
    headerCopyKey: headerKey(entryFlow, "my-image", showStylizeToggle),
    showStylizeToggle,
    sourceArea: "my-image",
    showTryAiUpsell: false,
    postSave,
  };
}

/**
 * Enumerate every cell. Used by tests + Storybook-equivalent mockups so we
 * can iterate the entire matrix without coupling tests to the implementation.
 */
export const ALL_MODES: Mode[] = ["stock", "self-upload"];
export const ALL_TIERS: Tier[] = ["unregistered", "registered", "legendary"];
export const ALL_ENTRY_FLOWS: EntryFlow[] = [
  "cold-permalink",
  "fact-detail",
  "library",
  "remix",
  "creation",
];

export interface MatrixRow {
  mode: Mode;
  tier: Tier;
  entryFlow: EntryFlow;
  cell: BehaviorCell;
}

export function enumerateMatrix(): MatrixRow[] {
  const out: MatrixRow[] = [];
  for (const mode of ALL_MODES) {
    for (const tier of ALL_TIERS) {
      for (const entryFlow of ALL_ENTRY_FLOWS) {
        out.push({ mode, tier, entryFlow, cell: resolveBehavior(mode, tier, entryFlow) });
      }
    }
  }
  return out;
}
