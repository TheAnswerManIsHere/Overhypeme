/**
 * @purpose Proves only a photo uploaded to the site counts as a member's real photo (#848): anything else, a provider picture included, leaves Profile asking for one.
 * @subsystem accounts-auth
 */
import { describe, it, expect } from "vitest";
import { hasUploadedProfilePhoto } from "./profile-photo";

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
