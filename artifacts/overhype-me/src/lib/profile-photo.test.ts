/**
 * @purpose Proves Profile's "Add a real photo of you" banner asks only an account that has not uploaded a photo of its own: an upload counts whether or not the account may show it as its picture (#848), while a Google or Apple picture alone still asks.
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
  it("does not ask a free account that uploaded a photo in onboarding (#848)", () => {
    // The upload route stores the photo but leaves avatarSource at "avatar"
    // for an account without custom_avatar, by design.
    expect(shouldAskForRealPhoto({ avatarSource: "avatar", profileImageUrl: UPLOAD })).toBe(false);
  });
  it("does not ask an account whose picture is its photo", () => {
    expect(shouldAskForRealPhoto({ avatarSource: "photo", profileImageUrl: UPLOAD })).toBe(false);
  });
  it("asks an account with no photo", () => {
    expect(shouldAskForRealPhoto({ avatarSource: "avatar", profileImageUrl: null })).toBe(true);
    expect(shouldAskForRealPhoto({ avatarSource: null, profileImageUrl: null })).toBe(true);
  });
  it("still asks an account whose only picture came from Google or Apple", () => {
    expect(shouldAskForRealPhoto({ avatarSource: "avatar", profileImageUrl: PROVIDER })).toBe(true);
  });
});
