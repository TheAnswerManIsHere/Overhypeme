import type { Request } from "express";

/** The fields of a meme row needed to decide who may view it. */
export interface MemeVisibility {
  isPublic: boolean;
  createdById: string | null;
}

/**
 * Whether the caller may view a specific meme.
 *
 * Public memes (`isPublic === true`, the default) are visible to everyone.
 * A private meme (`isPublic === false` — an explicit owner choice, only
 * available to legendary tier) is **owner-only**: visible solely to its creator
 * or an admin. A private meme with no creator (`createdById === null`, e.g. the
 * creator's account was deleted) is admin-only — we fail closed rather than
 * expose it.
 *
 * The single source of truth for meme visibility, shared by every surface that
 * resolves a meme by slug/id (detail JSON, rendered image, OG shell, share
 * copy/intents, Zazzle export). Callers MUST:
 *   - return **404** (not 403) to non-viewers, so a private meme's existence is
 *     not disclosed, and
 *   - keep private responses out of the public/edge cache (`no-store`), so the
 *     Cloudflare worker cannot cache them publicly.
 */
export function canViewMeme(meme: MemeVisibility, req: Request): boolean {
  if (meme.isPublic) return true;
  const userId = req.user?.id;
  if (userId && userId === meme.createdById) return true;
  if (req.user?.isRealAdmin === true) return true;
  return false;
}
