/**
 * @purpose Decides whether Profile asks a member for a real photo of themselves: only when they have not uploaded one to the site, whether or not their membership lets that photo be their picture (#848); a Google or Apple picture alone does not count.
 * @subsystem accounts-auth
 */

/**
 * The storage prefix of a photo uploaded to the site itself, the same prefix
 * the server's `normalizeProfileImageUrl` accepts as first-party
 * (`api-server/src/routes/users.ts`, `PROFILE_IMAGE_FIRST_PARTY_PREFIX`).
 * Anything else in `profileImageUrl` is a provider's picture from sign-in.
 */
const UPLOADED_PHOTO_PREFIX = "/api/storage/objects/";

export function hasUploadedProfilePhoto(profileImageUrl: string | null | undefined): boolean {
  return !!profileImageUrl && profileImageUrl.startsWith(UPLOADED_PHOTO_PREFIX);
}

/**
 * Whether the "Add a real photo of you" banner shows. An account without
 * `custom_avatar` keeps its generated avatar after uploading (the upload route
 * stores the photo and skips the `avatarSource` flip), so `avatarSource`
 * alone cannot say whether a photo was given.
 */
export function shouldAskForRealPhoto(profile: {
  avatarSource?: string | null;
  profileImageUrl?: string | null;
}): boolean {
  if (profile.avatarSource === "photo") return false;
  return !hasUploadedProfilePhoto(profile.profileImageUrl);
}
