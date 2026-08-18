/**
 * Which avatar image is public — decided in ONE place.
 * ────────────────────────────────────────────────────────────────────────────
 * Before this module, every call site decided for itself, and they disagreed:
 *
 *   • `Navbar.tsx` and `Profile.tsx` honoured `avatarSource` but checked no
 *     entitlement, so the custom-avatar upsell was unenforced on read.
 *   • `facts.ts`'s submitter and comment-author projections ignored
 *     `avatarSource` ENTIRELY, so a user who uploaded an identity photo for
 *     meme generation and never selected it as their avatar still had that
 *     photo shown publicly beside their submissions and comments. That is a
 *     pre-existing defect independent of entitlements, and it sits on the same
 *     projection the upsell has to fix anyway.
 *
 * Two properties worth stating, because they are what make this cheap:
 *
 * 1. IT RESOLVES THE SUBJECT'S ENTITLEMENT, NOT THE REQUESTER'S. Whose avatar
 *    is shown is governed by whether THAT account may have a custom one.
 * 2. LAPSE IS HANDLED FOR FREE, AND NO BACKFILL IS NEEDED. Because the
 *    projection is computed live, a user who selected a photo and later lapses
 *    reverts to the generated icon on the next read. No migration touches
 *    existing `avatar_source = 'photo'` rows.
 *
 * `profileImageUrl` stays a PRIVATE field. It remains available to the studio
 * and PuLID paths as the identity photo; what changes is that no *public*
 * projection emits it directly.
 */

import { can, type Principal } from "./featureAccess";

/** Matches the client's own `dicebearUrl` so the generated icon is unchanged. */
const DICEBEAR_BASE = "https://api.dicebear.com/9.x";
const DEFAULT_AVATAR_STYLE = "bottts";

export function generatedIconUrl(avatarStyle: string | null | undefined, userId: string): string {
  const style = avatarStyle || DEFAULT_AVATAR_STYLE;
  return `${DICEBEAR_BASE}/${style}/svg?seed=${encodeURIComponent(userId)}`;
}

/** The columns any caller must select to resolve a subject's effective avatar. */
export interface AvatarSubject {
  id: string;
  profileImageUrl: string | null;
  avatarSource: string | null;
  avatarStyle: string | null;
  /** The subject's EFFECTIVE tier — use `effectiveTierExpr()`, not the raw column. */
  membershipTier: string | null;
  /** The subject's real admin status, over all three grant mechanisms. */
  isRealAdmin: boolean;
}

function principalOf(subject: AvatarSubject): Principal {
  return {
    tier: subject.membershipTier ?? "unregistered",
    isAdmin: subject.isRealAdmin,
  };
}

/**
 * The one expression:
 *
 *   avatarSource === 'photo' && profileImageUrl != null && can(subject, 'custom_avatar')
 *     ? profileImageUrl
 *     : generatedIconUrl(...)
 */
export async function effectiveAvatarUrl(subject: AvatarSubject): Promise<string> {
  if (subject.avatarSource === "photo" && subject.profileImageUrl != null) {
    if (await can(principalOf(subject), "custom_avatar")) {
      return subject.profileImageUrl;
    }
  }
  return generatedIconUrl(subject.avatarStyle, subject.id);
}

/**
 * Batch form, for listing projections.
 *
 * Resolved over the batch of user ids the caller has ALREADY fetched, not per
 * row — the resolver reads one cached grid snapshot per process, so this adds
 * no per-row query. Returns a map from user id to the URL to emit.
 */
export async function effectiveAvatarUrls(
  subjects: readonly AvatarSubject[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const subject of subjects) {
    out.set(subject.id, await effectiveAvatarUrl(subject));
  }
  return out;
}
