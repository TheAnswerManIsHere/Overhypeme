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
 * copy/intents). Callers MUST:
 *   - return **404** to non-viewers, so the meme's content and state are not
 *     disclosed — with one exception: the meme detail route (`GET /memes/:slug`)
 *     answers a live private meme with 403 `{ private: true }`, so its page can
 *     say "this meme is private" (#591; David, 2026-11-21), and nothing more, and
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
