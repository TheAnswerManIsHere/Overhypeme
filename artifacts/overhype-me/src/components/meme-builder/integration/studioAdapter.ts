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
 * Maps the auth hook's UserRole vocabulary
 * (`anonymous|unregistered|registered|legendary|admin`) to the builder's
 * three-tier model. `anonymous` and `unregistered` collapse to
 * `unregistered`; `admin` collapses to `legendary`.
 */
export type UserRoleLike =
  | "anonymous"
  | "unregistered"
  | "registered"
  | "legendary"
  | "admin"
  | string
  | undefined;

export function roleToTier(role: UserRoleLike): Tier {
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
