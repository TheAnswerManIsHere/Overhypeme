/**
 * @purpose A member's picture, decided in one place (plan docs/plans/PLAN_PHOTO_IS_YOUR_PICTURE.md): the photo they uploaded and chose as their profile photo, for every member, or null (the browser then shows their initial). Only a first-party storage path is ever a picture, so no third-party image URL is served to other visitors.
 * @subsystem accounts-auth
 */

/** Where a member's uploaded photo is served from. */
export const PROFILE_PICTURE_PREFIX = "/api/storage/objects/";

/** The member's picture URL, or null when they have no uploaded photo. */
export function profilePictureUrl(stored: string | null | undefined): string | null {
  const value = stored?.trim();
  if (!value || !value.startsWith(PROFILE_PICTURE_PREFIX) || value.includes("..")) return null;
  return value;
}
