/**
 * @purpose Decides whether Profile asks a member for a real photo of themselves: only when they have not uploaded one to the site (#848). Their uploaded photo is their picture, for every member (plan PLAN_PHOTO_IS_YOUR_PICTURE.md).
 * @subsystem accounts-auth
 */

/**
 * The storage prefix of a photo uploaded to the site itself, the one prefix
 * the server's picture rule accepts (`api-server/src/lib/profilePicture.ts`).
 */
const UPLOADED_PHOTO_PREFIX = "/api/storage/objects/";

export function hasUploadedProfilePhoto(profileImageUrl: string | null | undefined): boolean {
  return !!profileImageUrl && profileImageUrl.startsWith(UPLOADED_PHOTO_PREFIX);
}

/** Whether the "Add a real photo of you" banner shows: the member has no uploaded photo. */
export function shouldAskForRealPhoto(profile: { profileImageUrl?: string | null }): boolean {
  return !hasUploadedProfilePhoto(profile.profileImageUrl);
}
