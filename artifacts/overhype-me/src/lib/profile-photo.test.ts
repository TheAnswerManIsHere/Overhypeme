/**
 * @purpose Proves Profile's "Add a real photo of you" banner asks only an account that has not uploaded a photo of its own: an upload counts for every member (#848), and anything that is not an uploaded photo still asks.
 * @subsystem accounts-auth
 */
import { describe, it, expect } from "vitest";
import { hasUploadedProfilePhoto, shouldAskForRealPhoto } from "./profile-photo";

const UPLOAD = "/api/storage/objects/uploads/8f1c";
const PROVIDER = "https://lh3.googleusercontent.com/a/abc";

describe("hasUploadedProfilePhoto", () => {
  it("is true for a photo uploaded to the site's own storage", () => {
    expect(hasUploadedProfilePhoto(UPLOAD)).toBe(true);
  });
  it("is false for a provider picture, an empty value or none", () => {
    expect(hasUploadedProfilePhoto(PROVIDER)).toBe(false);
    expect(hasUploadedProfilePhoto("")).toBe(false);
    expect(hasUploadedProfilePhoto(null)).toBe(false);
    expect(hasUploadedProfilePhoto(undefined)).toBe(false);
  });
});

describe("shouldAskForRealPhoto", () => {
  it("does not ask a member who uploaded a photo, free or Legendary (#848)", () => {
    expect(shouldAskForRealPhoto({ profileImageUrl: UPLOAD })).toBe(false);
  });
  it("asks a member with no photo", () => {
    expect(shouldAskForRealPhoto({ profileImageUrl: null })).toBe(true);
    expect(shouldAskForRealPhoto({})).toBe(true);
  });
  it("asks when the only value is not an uploaded photo", () => {
    expect(shouldAskForRealPhoto({ profileImageUrl: PROVIDER })).toBe(true);
  });
});
