/**
 * Phase-5 viewer-state resolution.
 *
 * Pure module — no React imports. Inputs are the auth user, the meme being
 * viewed, and the transient `?just_created=1` flag. Output is one of seven
 * cells; the page renders a different CTA bar per cell.
 *
 * Anonymous-viewing-own is a TRANSIENT post-render state. It only exists
 * when the meme has no createdById (the save was an anonymous render that
 * was never persisted under a user) AND the viewer arrived with the
 * just-created flag set by MemeBuilder on success.
 */

export type ViewerCell =
  | "anon-other"
  | "anon-own-transient"
  | "registered-own"
  | "registered-other"
  | "legendary-own-stock"
  | "legendary-own-pulid"
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
    imageTransform: string | null | undefined;
  };
  justCreated: boolean;
  /**
   * `can("meme_pulid_stylize")` from the caller — told, not derived. Decides
   * the OWN-meme branch: whether "Turn this up to 11" opens the real PuLID
   * flow (legendary-own-stock/-pulid) or an inert upsell (registered-own).
   * This used to be `role === "legendary" || role === "admin"` — the same
   * PR #402 shape, and the reason a grid grant/revocation wouldn't move this
   * button. The "other" branches below stay role-derived: they only decide
   * whether a marketing upsell card is shown on someone ELSE's meme, not any
   * actual capability, so there's no PR #402-shaped risk in leaving them be.
   */
  canPulidStylize: boolean;
}

function isLegendaryRole(role: Role): boolean {
  return role === "legendary" || role === "admin";
}

function isAnonRole(role: Role): boolean {
  return role === "anonymous" || role === "unregistered";
}

export function resolveViewerCell(input: ResolveViewerCellInput): ViewerCell {
  const { role, userId, meme, justCreated, canPulidStylize } = input;
  const isOwn = !!userId && !!meme.createdById && userId === meme.createdById;

  if (isAnonRole(role)) {
    // Anonymous "own" only exists immediately after a transient render —
    // there's no userId to match against, so we use the just-created flag
    // plus a null createdById as the signal.
    if (justCreated && !meme.createdById) return "anon-own-transient";
    return "anon-other";
  }

  if (isOwn) {
    if (canPulidStylize) {
      return meme.imageTransform === "pulid"
        ? "legendary-own-pulid"
        : "legendary-own-stock";
    }
    return "registered-own";
  }

  return isLegendaryRole(role) ? "legendary-other" : "registered-other";
}
