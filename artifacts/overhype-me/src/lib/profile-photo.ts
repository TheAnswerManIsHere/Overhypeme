/**
 * @purpose Decides whether a member has a real photo of themselves: only one uploaded to the site counts (#848), so Profile's identity card asks everyone else for one. Their uploaded photo is their picture, for every member (plan PLAN_PHOTO_IS_YOUR_PICTURE.md).
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
