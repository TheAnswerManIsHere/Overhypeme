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
  ViewerContext,
} from "./types";

/**
 * The two grid entitlements this matrix consults. Required, not optional —
 * every real call site has a resolved `ViewerContext.entitlements` to read
 * these from, and a missing/unresolved caller should fail to typecheck rather
 * than silently defaulting to `tier === "legendary"`.
 *
 * `showStylizeToggle` (PuLID) and `showTryAiUpsell` (AI backgrounds) used to
 * be derived from `tier` alone, which is the same PR #402 shape everywhere
 * else in this codebase: the client decided who could select PuLID from a
 * value the server does not use for that decision, so a grid change (an
 * operator granting `meme_pulid_stylize` to `registered`, or revoking it from
 * `legendary`) would leave this screen showing the old, wrong answer.
 */
export interface BehaviorEntitlements {
  meme_pulid_stylize: boolean;
  meme_ai_background: boolean;
}

/**
 * Reads the two keys this matrix needs out of the server's resolved payload.
 * The one place this mapping happens, so every call site fails closed the
 * same way: an absent map (payload not loaded yet) or an absent key (server
 * genuinely doesn't grant it) both read as `false` — never `true`. That
 * matches the resolver's own behaviour for a missing row, and it means a
 * builder rendered before the entitlement payload arrives shows the locked
 * state rather than a briefly-permissive one.
 */
export function entitlementsFromViewerContext(viewerContext: ViewerContext): BehaviorEntitlements {
  return {
    meme_pulid_stylize: viewerContext.entitlements?.["meme_pulid_stylize"]?.allowed === true,
    meme_ai_background: viewerContext.entitlements?.["meme_ai_background"]?.allowed === true,
  };
}

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
  entitlements: BehaviorEntitlements,
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

    const showTryAiUpsell = entitlements.meme_ai_background;
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
  const showStylizeToggle = entitlements.meme_pulid_stylize;

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

/**
 * Demo/enumeration-only entitlement stand-in. Real call sites read the
 * server's resolved `ViewerContext.entitlements`; this exists only so the
 * matrix enumeration (tests, the Storybook-equivalent harness) can walk the
 * `tier` axis without a live server payload. `legendary` is given both
 * entitlements so the enumeration still shows every reachable cell shape —
 * it is not a claim that tier and entitlement are the same thing.
 */
export function demoEntitlementsForTier(tier: Tier): BehaviorEntitlements {
  const granted = tier === "legendary";
  return { meme_pulid_stylize: granted, meme_ai_background: granted };
}

export function enumerateMatrix(): MatrixRow[] {
  const out: MatrixRow[] = [];
  for (const mode of ALL_MODES) {
    for (const tier of ALL_TIERS) {
      for (const entryFlow of ALL_ENTRY_FLOWS) {
        const cell = resolveBehavior(mode, tier, entryFlow, demoEntitlementsForTier(tier));
        out.push({ mode, tier, entryFlow, cell });
      }
    }
  }
  return out;
}
