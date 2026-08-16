import { describe, it, expect } from "vitest";
import GithubSlugger from "github-slugger";
import { INTERNAL_HELP_PATH, internalHelpTarget, helpHref } from "./helpLinkGuard";

/** Through the real consumer, via a stub element — no DOM needed. */
const parse = (raw: string) =>
  internalHelpTarget({ getAttribute: (k: string) => (k === "data-help-internal" ? raw : null) } as unknown as Element);

const accepts = (s: string) => parse(s) !== null;

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

  it("splits the target into an ASCII path and a raw fragment", () => {
    expect(parse("/admin/help/3-moderation#the-queue")).toEqual({
      path: "/admin/help/3-moderation",
      fragment: "the-queue",
    });
    expect(parse("/admin/help")).toEqual({ path: "/admin/help", fragment: "" });
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
    expect(accepts("/admin/help/café"), "chapter slugs come from filenames and stay ASCII").toBe(false);
  });

  // A fragment cannot change where navigation goes, so it is split off rather
  // than pattern-matched — the security property lives entirely in the path.
  // These prove the split does not weaken that: an origin-changing prefix is
  // still rejected no matter what follows the `#`.
  it("keeps rejecting origin-changing values regardless of the fragment", () => {
    for (const bad of [
      "//evil.com#café",
      "https://evil.com/admin/help#x",
      "javascript:alert(1)#x",
      "/admin/config#café",
    ]) {
      expect(accepts(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

/**
 * THE PRODUCER'S ACTUAL ALPHABET, not a guess at it.
 *
 * The previous version of this guard held the fragment to `[A-Za-z0-9._-]`,
 * which rejected links `github-slugger` legitimately produces. Replacing that
 * with a hand-written Unicode class would have been a guess — verified
 * empirically to be an incomplete one, since the slugger also emits combining
 * marks, connector punctuation and enclosed alphanumerics. So the fragment is
 * not matched at all, and these tests run REAL slugger output through the
 * guard rather than asserting a character class I believe it uses.
 */
describe("the guard accepts whatever github-slugger produces", () => {
  const slugOf = (heading: string) => new GithubSlugger().slug(heading);

  it("accepts real slugs from every script, including ones a character class would miss", () => {
    for (const heading of [
      "café au lait",
      "Straße",
      "日本語の見出し",
      "русский заголовок",
      "Ωmega ϑeta",
      "Ñoño",
      "emoji 🎉 heading",   // slugger STRIPS the emoji -> "emoji--heading"
      "C++ & you",
      'quote "x"',
      "v1.2.3 release",
      "paren (x)",
      "under_score",
    ]) {
      const slug = slugOf(heading);
      const raw = `/admin/help/3-moderation#${slug}`;
      const target = parse(raw);
      expect(target, `guard rejected a real slug for ${JSON.stringify(heading)} -> ${JSON.stringify(slug)}`).not.toBeNull();
      expect(target!.fragment).toBe(slug);
    }
  });

  it("emits an ASCII href that round-trips back to the slug", () => {
    // Percent-encoding is what makes the fragment safe to place in an href at
    // all; `currentHash()` decodes it on the way back, so the pair must be
    // lossless or a cold bookmark lands nowhere.
    for (const heading of ["café au lait", "日本語の見出し", "Ñoño", "under_score"]) {
      const slug = slugOf(heading);
      const href = helpHref("/base", { path: "/admin/help/3-moderation", fragment: slug });
      expect(href.startsWith("/base/admin/help/3-moderation#")).toBe(true);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(href), `href should be ASCII: ${href}`).toBe(true);
      expect(decodeURIComponent(href.split("#")[1])).toBe(slug);
    }
  });

  it("leaves an already-ASCII slug readable in the href", () => {
    expect(helpHref("", { path: "/admin/help/3-moderation", fragment: "a_slug-with.dots" }))
      .toBe("/admin/help/3-moderation#a_slug-with.dots");
    expect(helpHref("/admin", { path: "/admin/help", fragment: "" })).toBe("/admin/admin/help");
  });
});

describe("INTERNAL_HELP_PATH", () => {
  // Exported for the generator/consumer contract test, which checks the
  // committed artifact's anchors. It now matches the PATH only.
  it("matches paths without fragments", () => {
    expect(INTERNAL_HELP_PATH.test("/admin/help/3-moderation")).toBe(true);
    expect(INTERNAL_HELP_PATH.test("/admin/help/3-moderation#x")).toBe(false);
    expect(INTERNAL_HELP_PATH.test("//evil.com")).toBe(false);
  });
});
