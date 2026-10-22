/**
 * Phase-5 viewer-state resolution.
 *
 * Pure module — no React imports. Inputs are the auth user, the meme being
 * viewed, and the transient `?just_created=1` flag. Output is one of five
 * cells; the page renders a different CTA bar per cell.
 *
 * Every signed-in owner gets the one "own" cell. It used to split three ways
 * (registered-own, legendary-own-stock, legendary-own-pulid) on whether the
 * owner could open PuLID's "Turn this up to 11" flow and whether the meme was
 * already PuLID-made; PuLID went in launch Phase 4, removal 3, and with it
 * every difference between those three.
 *
 * Anonymous-viewing-own is a TRANSIENT post-render state. It only exists
 * when the meme has no createdById (the save was an anonymous render that
 * was never persisted under a user) AND the viewer arrived with the
 * just-created flag set by MemeBuilder on success.
 */

export type ViewerCell =
  | "anon-other"
  | "anon-own-transient"
  | "own"
  | "registered-other"
  | "legendary-other";

export type Role =
  | "anonymous"
  | "unregistered"
  | "registered"
  | "legendary"
  | "admin";

export interface ResolveViewerCellInput {
  role: Role;
  userId: string | null | undefined;
  meme: {
    createdById: string | null | undefined;
  };
  justCreated: boolean;
}

function isLegendaryRole(role: Role): boolean {
  return role === "legendary" || role === "admin";
}

function isAnonRole(role: Role): boolean {
  return role === "anonymous" || role === "unregistered";
}

export function resolveViewerCell(input: ResolveViewerCellInput): ViewerCell {
  const { role, userId, meme, justCreated } = input;
  const isOwn = !!userId && !!meme.createdById && userId === meme.createdById;

  if (isAnonRole(role)) {
    // Anonymous "own" only exists immediately after a transient render —
    // there's no userId to match against, so we use the just-created flag
    // plus a null createdById as the signal.
    if (justCreated && !meme.createdById) return "anon-own-transient";
    return "anon-other";
  }

  if (isOwn) return "own";

  // The "other" branches stay role-derived: they decide only the remix
  // button's styling on someone ELSE's meme, never a capability.
  return isLegendaryRole(role) ? "legendary-other" : "registered-other";
}
