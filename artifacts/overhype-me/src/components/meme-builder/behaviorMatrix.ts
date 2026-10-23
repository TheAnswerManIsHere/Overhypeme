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

function headerKey(entryFlow: EntryFlow): HeaderCopyKey {
  if (entryFlow === "remix") return "make-this-your-own";
  return "build-your-meme";
}

export function resolveBehavior(
  _mode: Mode,
  tier: Tier,
  entryFlow: EntryFlow,
): BehaviorCell {
  // ── Invalid: self-upload requires registration ────────────────────────
  // (Stock photos were the one source open to an unregistered viewer; they
  // went with Pexels, launch Phase 4, removal 6.)
  if (tier === "unregistered") {
    return {
      invalid: true,
      upgradeTo: "registered",
      upgradeReason: "Sign up free to upload your photo",
      visibleActions: [],
      headerCopyKey: "build-your-meme",
      sourceArea: "my-image",
      postSave: "none",
    };
  }

  // ── self-upload × registered/legendary ────────────────────────────────
  const visibleActions: Action[] = ["download", "save", "share"];
  const postSave: BehaviorCell["postSave"] = "back-to-fact";

  return {
    invalid: false,
    visibleActions,
    headerCopyKey: headerKey(entryFlow),
    sourceArea: "my-image",
    postSave,
  };
}

/**
 * Enumerate every cell. Used by tests + Storybook-equivalent mockups so we
 * can iterate the entire matrix without coupling tests to the implementation.
 */
export const ALL_MODES: Mode[] = ["self-upload"];
export const ALL_TIERS: Tier[] = ["unregistered", "registered", "legendary"];
export const ALL_ENTRY_FLOWS: EntryFlow[] = [
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
        const cell = resolveBehavior(mode, tier, entryFlow);
        out.push({ mode, tier, entryFlow, cell });
      }
    }
  }
  return out;
}
