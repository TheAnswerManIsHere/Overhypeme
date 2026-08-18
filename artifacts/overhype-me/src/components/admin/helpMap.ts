/**
 * Which part of the Manual answers "what does THIS admin screen do?".
 *
 * This map is a product judgment — it is not derivable from anything, which is
 * why it is hand-written here rather than generated. Two tests keep it honest
 * (`helpMap.test.ts`), because nothing else would:
 *
 *   - COMPLETENESS: a nav item added later with no entry means a `?` that
 *     silently does nothing.
 *   - RESOLVABILITY: a heading renamed in `docs/manual/` six weeks from now
 *     leaves a `?` pointing at an anchor that no longer exists, and nobody
 *     finds out until an admin clicks it. `pnpm run check:docs` validates
 *     linked *files* but explicitly not anchors.
 *
 * Deliberately holds string literals only and imports nothing generated.
 * `AdminLayout` imports this, and `AdminLayout` is in the shared admin chunk —
 * importing the manifest here would drag help content into every admin screen,
 * which is exactly the boundary `helpBundleBoundary.test.ts` asserts.
 */

export interface HelpTarget {
  /** Chapter slug, matching `docs/manual/<slug>.md`. */
  chapter: string;
  /** Optional section anchor within that chapter. */
  anchor?: string;
}

/**
 * Keyed by the admin route in `AdminLayout`'s `NAV_ITEMS`.
 *
 * The three redirect routes (`/admin/comments`, `/admin/reviews` → moderation;
 * `/admin/ai` → config) need no entry: they redirect before `AdminLayout`
 * renders, so the `?` reads the destination's location, not theirs.
 */
export const ADMIN_HELP_MAP: Record<string, HelpTarget> = {
  "/admin": { chapter: "11-admin-console" },
  "/admin/facts": { chapter: "2-content-lifecycle" },
  "/admin/users": { chapter: "11-admin-console", anchor: "managing-people" },
  "/admin/moderation": { chapter: "3-moderation" },
  // No chapter covers the eval dashboard yet; chapter 5 is the nearest
  // neighbour because eval scores image-prompt attempts. A real documentation
  // gap, logged as a /document follow-up on issue #463 rather than papered over.
  "/admin/eval": { chapter: "5-visual-pipeline" },
  "/admin/billing": { chapter: "10-payments-and-membership", anchor: "for-the-admin" },
  "/admin/refunds-disputes": { chapter: "10-payments-and-membership", anchor: "for-the-admin" },
  "/admin/affiliate": { chapter: "7-public-site-and-sharing", anchor: "turning-a-meme-into-merch" },
  "/admin/video-styles": { chapter: "6-meme-and-video-studio" },
  // Engines, Features and Configuration genuinely share one section — that is
  // what the Manual currently covers them under, not a mapping shortcut.
  "/admin/engines": { chapter: "11-admin-console", anchor: "tuning-how-the-product-behaves" },
  "/admin/taxonomy-health": { chapter: "4-taxonomy-and-enrichment", anchor: "for-the-admin-taxonomy-health" },
  "/admin/email-queue": { chapter: "12-background-work", anchor: "email-the-most-consequential-rider" },
  "/admin/queue-health": { chapter: "12-background-work", anchor: "worker-liveness-and-the-queue-health-surface" },
  "/admin/features": { chapter: "11-admin-console", anchor: "tuning-how-the-product-behaves" },
  "/admin/config": { chapter: "11-admin-console", anchor: "tuning-how-the-product-behaves" },
};

/**
 * Normalise a router location before lookup.
 *
 * The router renders `/admin/queue-health/` the same as `/admin/queue-health`,
 * and `isAdminNavItemActive` treats both as active — but an exact-key lookup
 * misses the trailing-slash form, so the `?` would silently fall back to the
 * index instead of the section it promises. Query and hash are stripped for
 * the same reason.
 */
function normaliseLocation(location: string): string {
  const path = location.split("?")[0].split("#")[0];
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The in-app URL a `?` control points at, or the help index if unmapped. */
export function helpHrefFor(location: string): string {
  const target = ADMIN_HELP_MAP[normaliseLocation(location)];
  if (!target) return "/admin/help";
  return `/admin/help/${target.chapter}${target.anchor ? `#${target.anchor}` : ""}`;
}
