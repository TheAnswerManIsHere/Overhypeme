import { describe, it, expect } from "vitest";
import { INTERNAL_HELP_PATH } from "./helpLinkGuard";

const accepts = (s: string) => INTERNAL_HELP_PATH.test(s);

describe("internal help link guard", () => {
  it("accepts the shapes the generator actually emits", () => {
    for (const ok of [
      "/admin/help",
      "/admin/help#contents",
      "/admin/help/3-moderation",
      "/admin/help/12-background-work#worker-liveness-and-the-queue-health-surface",
      "/admin/help/4-taxonomy-and-enrichment#for-the-admin-taxonomy-health",
      "/admin/help/1-personalization-and-grammar#a_slug_with_underscores",
    ]) {
      expect(accepts(ok), `should accept ${ok}`).toBe(true);
    }
  });

  // github-slugger keeps non-ASCII letters, so the generator can legitimately
  // emit `#café`. An ASCII-only fragment class rejected it — and a rejected
  // marker means the href never gets base-prefixed and the click falls back to
  // a full page load, silently.
  it("accepts the non-ASCII fragments github-slugger actually produces", () => {
    for (const ok of [
      "/admin/help/3-moderation#café",
      "/admin/help/3-moderation#straße",
      "/admin/help/4-taxonomy-and-enrichment#日本語の見出し",
      "/admin/help#emoji-🎉-heading",
    ]) {
      expect(accepts(ok), `should accept ${ok}`).toBe(true);
    }
  });

  // The widened fragment must not have reopened the hole the module exists to
  // close. Only the leading PATH can change where navigation goes, so these
  // stay rejected no matter what the fragment allows.
  it("still rejects origin-changing values after the fragment was widened", () => {
    for (const bad of [
      "//evil.com#café",
      "/admin/help/3-moderation#a/b",
      "/admin/help/3-moderation#javascript:alert(1)",
      "/admin/help/3-moderation#x?y",
      "/admin/help/3-moderation#a#b",
      "/admin/help/3-moderation#with space",
      "/admin/help/3-moderation#back\\slash",
      "/admin/help/café",
    ]) {
      expect(accepts(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  // The reason this module exists. `startsWith("/")` accepted the first two,
  // and the first one is a protocol-relative URL that navigates off-site.
  it("rejects the values the old startsWith('/') guard let through", () => {
    for (const bad of ["//evil.com", "//evil.com/admin/help", "/admin/config", "/"]) {
      expect(accepts(bad), `should reject ${bad}`).toBe(false);
    }
  });

  it("rejects anything that could execute or leave the app", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://evil.com/admin/help",
      "http://evil.com",
      "\\/\\/evil.com",
      " /admin/help",
      "/admin/help/../../etc/passwd",
      "",
    ]) {
      expect(accepts(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("rejects a nested path that is not a chapter slug", () => {
    expect(accepts("/admin/help/a/b")).toBe(false);
  });
});
