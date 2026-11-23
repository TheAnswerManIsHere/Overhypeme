/**
 * @purpose A member's picture is their uploaded photo or nothing (plan PLAN_PHOTO_IS_YOUR_PICTURE.md): profilePictureUrl passes only a first-party storage path, so no third-party image URL is ever served as someone's picture.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profilePictureUrl } from "../lib/profilePicture.js";

describe("profilePictureUrl", () => {
  it("is the uploaded photo's URL", () => {
    assert.equal(profilePictureUrl("/api/storage/objects/uploads/ab/1.jpg"), "/api/storage/objects/uploads/ab/1.jpg");
    assert.equal(profilePictureUrl("  /api/storage/objects/uploads/ab/1.jpg  "), "/api/storage/objects/uploads/ab/1.jpg");
  });

  it("is null for no photo, a provider or stock URL, a data URL, or a path that climbs out of storage", () => {
    for (const v of [null, undefined, "", "   ", "https://lh3.googleusercontent.com/a/x=s96-c", "https://images.unsplash.com/photo-1",
      "data:image/jpeg;base64,AAAA", "/objects/uploads/x.jpg", "/api/storage/objects/../../secret"]) {
      assert.equal(profilePictureUrl(v), null, String(v));
    }
  });
});
