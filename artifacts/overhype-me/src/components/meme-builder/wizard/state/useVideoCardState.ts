/**
 * Resolves the rendering state for the video card on Step 1 of the wizard.
 *
 * MBFO-2 ships without the client-side video-budget endpoint (`videoBudget`
 * is always undefined here). Legendary users are therefore treated as
 * `tappable` for now; the server-side budget gate still blocks at video
 * generation time. MBFO-4 wires the budget endpoint and the
 * `budget-reached` cell becomes reachable.
 *
 * The shape is forward-compatible: pass `videoBudget` as `{ allowed: false,
 * resetDate }` to render the budget-reached state today.
 */

import type { Tier } from "../../types";

export type VideoCardState =
  | { kind: "tappable" }
  | { kind: "locked-upgrade" }
  | { kind: "budget-reached"; resetDate: string };

export interface VideoBudgetSnapshot {
  allowed: boolean;
  /** ISO date string for "your reset is {date}" copy. */
  resetDate?: string;
}

export interface ResolveVideoCardArgs {
  tier: Tier;
  /** Undefined while MBFO-4's budget endpoint isn't called yet. */
  videoBudget?: VideoBudgetSnapshot;
}

export function resolveVideoCardState(args: ResolveVideoCardArgs): VideoCardState {
  if (args.tier !== "legendary") {
    return { kind: "locked-upgrade" };
  }
  if (args.videoBudget && !args.videoBudget.allowed) {
    return { kind: "budget-reached", resetDate: args.videoBudget.resetDate ?? "" };
  }
  return { kind: "tappable" };
}

/**
 * Hook wrapper — purely derived, kept as a hook so future MBFO-4 work can
 * fetch the budget snapshot inside it without disturbing call sites.
 */
export function useVideoCardState(args: ResolveVideoCardArgs): VideoCardState {
  return resolveVideoCardState(args);
}
