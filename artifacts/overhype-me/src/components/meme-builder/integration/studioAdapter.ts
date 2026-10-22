/**
 * The builder's identity helper, shared by the fact-page wizard and the
 * meme-page remix builder. The legacy meme studio's path-to-mode and
 * profile-URL helpers that used to live here went with the studio (launch
 * Phase 4, removal 1; `docs/retired/README.md`).
 */

import type { Tier } from "../types";

/**
 * Maps the auth hook's UserRole vocabulary to the builder's identity model.
 *
 * `roleToTier` USED TO LIVE HERE and is deleted. It collapsed `admin` into
 * `legendary` client-side, and that mapping is the PR #402 bug: the builder
 * offered a Private pill on the strength of it while `createMemeRecord`
 * resolved the same entitlement from the tier column, found `registered`, and
 * coerced the meme public.
 *
 * What replaces it is NOT a better mapping — it is the removal of the question.
 * The builder is told its entitlements by the server (`ViewerContext.entitlements`)
 * and never derives them. This function survives only for the
 * identity-prerequisite question the builder genuinely has: "is this viewer
 * signed in at all?", which decides whether saving is possible before any
 * entitlement is consulted. It deliberately does NOT distinguish legendary from
 * registered, so it cannot be misused as a permission check.
 */
export type UserRoleLike =
  | "anonymous"
  | "unregistered"
  | "registered"
  | "legendary"
  | "admin"
  | string
  | undefined;

export function roleToIdentity(role: UserRoleLike): Tier {
  if (role === "legendary" || role === "admin") return "legendary";
  if (role === "registered") return "registered";
  return "unregistered";
}
