/**
 * Pure helpers used by `MemeStudio.tsx` to bridge the studio's path-based
 * surface to the new universal `MemeBuilder` (mode, tier, viewerContext).
 *
 * Extracted from `MemeStudio.tsx` so the mapping logic can be unit-tested
 * without mounting React or the full studio shell.
 */

import type { Mode, Tier } from "../types";

export type StudioImagePath =
  | "ai-gallery"
  | "photo-image"
  | "stock-image"
  | "gradient-image";

/**
 * Maps a studio image path to a builder mode.
 *
 *   stock-image    → "stock"
 *   gradient-image → "stock" (gradient is being deprecated; soft-redirect)
 *   photo-image    → "self-upload"
 *   ai-gallery     → "self-upload" (legendary stylize toggle is exposed)
 */
export function studioPathToMode(path: StudioImagePath): Mode {
  if (path === "stock-image" || path === "gradient-image") return "stock";
  return "self-upload";
}

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

/**
 * Extracts the storage object_path from a profile image URL. Returns
 * undefined for external URLs / generated avatars / null inputs.
 *
 * In our storage layer the public download path is
 *   /api/storage/objects/<object-path-fragment>
 * and the canonical object_path stored on upload_image_metadata starts with
 *   /objects/...
 * (the leading "/api/storage" prefix is the route mount, not part of the
 * object_path).
 */
export function extractObjectPath(profileImageUrl?: string | null): string | undefined {
  if (!profileImageUrl) return undefined;
  const PREFIX = "/api/storage/objects/";
  const idx = profileImageUrl.indexOf(PREFIX);
  if (idx === -1) return undefined;
  const rest = profileImageUrl.slice(idx + PREFIX.length);
  if (!rest) return undefined;
  return `/objects/${rest}`;
}
