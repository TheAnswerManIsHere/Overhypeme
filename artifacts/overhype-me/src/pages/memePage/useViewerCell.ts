/**
 * Phase-5 viewer-state resolution.
 *
 * Pure module — no React imports. Inputs are the auth user, the meme being
 * viewed. Output is one of four cells; the page renders a different CTA bar
 * per cell.
 *
 * Every signed-in owner gets the one "own" cell. It used to split three ways
 * (registered-own, legendary-own-stock, legendary-own-pulid) on whether the
 * owner could open PuLID's "Turn this up to 11" flow and whether the meme was
 * already PuLID-made; PuLID went in launch Phase 4, removal 3, and with it
 * every difference between those three.
 *
 * A signed-out viewer always gets "anon-other". The "anon-own-transient"
 * cell (a signed-out visitor's just-rendered meme, flagged `?just_created=1`)
 * went in launch Phase 4, removal 11: nothing sets the flag, and a signed-out
 * visitor can no longer make a meme.
 */

export type ViewerCell =
  | "anon-other"
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
}

function isLegendaryRole(role: Role): boolean {
  return role === "legendary" || role === "admin";
}

function isAnonRole(role: Role): boolean {
  return role === "anonymous" || role === "unregistered";
}

export function resolveViewerCell(input: ResolveViewerCellInput): ViewerCell {
  const { role, userId, meme } = input;
  const isOwn = !!userId && !!meme.createdById && userId === meme.createdById;

  if (isAnonRole(role)) return "anon-other";

  if (isOwn) return "own";

  // The "other" branches stay role-derived: they decide only the remix
  // button's styling on someone ELSE's meme, never a capability.
  return isLegendaryRole(role) ? "legendary-other" : "registered-other";
}
