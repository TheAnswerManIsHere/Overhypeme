import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getSafeReturnTo, loginHrefFrom } from "./safe-return-to";

describe("getSafeReturnTo", () => {
  it("passes through a plain same-origin path", () => {
    expect(getSafeReturnTo("/facts/123")).toBe("/facts/123");
    expect(getSafeReturnTo("/profile")).toBe("/profile");
    expect(getSafeReturnTo("/")).toBe("/");
  });

  it("preserves query and hash on an otherwise safe path", () => {
    expect(getSafeReturnTo("/facts/123?tab=memes")).toBe("/facts/123?tab=memes");
    expect(getSafeReturnTo("/facts/123#comments")).toBe("/facts/123#comments");
    expect(getSafeReturnTo("/f?a=1#b")).toBe("/f?a=1#b");
  });

  it("returns null for an absent or non-string value", () => {
    expect(getSafeReturnTo(null)).toBe(null);
    expect(getSafeReturnTo(undefined)).toBe(null);
    expect(getSafeReturnTo("")).toBe(null);
  });

  // The regression: each of these previously flowed unvalidated into
  // `window.location.href` after a successful login.
  it("rejects absolute URLs on another origin (open redirect)", () => {
    expect(getSafeReturnTo("https://evil.com")).toBe(null);
    expect(getSafeReturnTo("http://evil.com/path")).toBe(null);
    expect(getSafeReturnTo("https://evil.com/facts/1")).toBe(null);
  });

  it("rejects protocol-relative URLs", () => {
    expect(getSafeReturnTo("//evil.com")).toBe(null);
    expect(getSafeReturnTo("//evil.com/facts/1")).toBe(null);
  });

  it("rejects non-path schemes (script injection)", () => {
    expect(getSafeReturnTo("javascript:alert(1)")).toBe(null);
    expect(getSafeReturnTo("JavaScript:alert(1)")).toBe(null);
    expect(getSafeReturnTo("data:text/html,<script>alert(1)</script>")).toBe(null);
    expect(getSafeReturnTo("vbscript:msgbox(1)")).toBe(null);
  });

  // WHATWG URL parsing treats backslashes in a special-scheme URL as forward
  // slashes, and strips tab/newline entirely — so a value can pass a naive
  // `startsWith("//")` check and still resolve to a foreign host. The hostname
  // check after parsing is what actually catches these.
  it("rejects backslash and control-character smuggling past the prefix check", () => {
    // None of these start with "//", so the prefix check alone misses every
    // one of them; each resolves to hostname `evil.com` once parsed.
    expect(getSafeReturnTo("/\\evil.com")).toBe(null);
    expect(getSafeReturnTo("/\\/evil.com")).toBe(null);
    expect(getSafeReturnTo("/\t/evil.com")).toBe(null);
    expect(getSafeReturnTo("/\n/evil.com")).toBe(null);
    expect(getSafeReturnTo("/\r/evil.com")).toBe(null);
    expect(getSafeReturnTo("/\t\\evil.com")).toBe(null);
  });

  it("keeps a stripped control character that leaves the path same-origin", () => {
    // `/<tab>evil.com` collapses to the same-origin path `/evil.com` — a page
    // on our own site, not a redirect off it. Rejecting it would be wrong.
    expect(getSafeReturnTo("/\tevil.com")).toBe("/evil.com");
  });

  it("rejects a value that does not start with a slash", () => {
    expect(getSafeReturnTo("facts/123")).toBe(null);
    expect(getSafeReturnTo("evil.com")).toBe(null);
    expect(getSafeReturnTo(" /facts/123")).toBe(null);
  });

  // Codex review, PR #292: RFC 3986 dot-segment removal means a value can
  // fail both the "//" prefix check and the hostname check, yet still
  // resolve to a protocol-relative path once WHATWG URL normalizes it.
  it("rejects a value whose dot-segment-normalized path becomes protocol-relative", () => {
    // Neither starts with "//", and both resolve to hostname "localhost" —
    // only re-checking the *serialized* path afterward catches these.
    expect(getSafeReturnTo("/a/..//evil.com")).toBe(null);
    expect(getSafeReturnTo("/..//evil.com")).toBe(null);
    expect(getSafeReturnTo("/a/../..//evil.com")).toBe(null);
    expect(getSafeReturnTo("/a/b/../..//evil.com")).toBe(null);
  });

  it("still resolves a dot-segment path that normalizes to a same-origin path", () => {
    expect(getSafeReturnTo("/a/../evil.com")).toBe("/evil.com");
    expect(getSafeReturnTo("/facts/../profile")).toBe("/profile");
  });

  // Codex review, PR #292 round 2: percent-encoded spellings of ".." reach the
  // same dangerous serialization as the literal-dot case above, once decoded.
  // These already pass against the fix — this pins that behavior against a
  // future parser or validation rewrite silently regressing it.
  it("rejects percent-encoded dot-segment spellings that resolve to protocol-relative", () => {
    expect(getSafeReturnTo("/a/%2e%2e//evil.com")).toBe(null);
    expect(getSafeReturnTo("/a/.%2e//evil.com")).toBe(null);
    expect(getSafeReturnTo("/a/%2e.//evil.com")).toBe(null);
  });

  it("still resolves a percent-encoded dot-segment path that normalizes same-origin", () => {
    expect(getSafeReturnTo("/a/%2e%2e/evil.com")).toBe("/evil.com");
  });
});

// Q6 (Issue #1132): every sign-in returns to the page you were on.
describe("loginHrefFrom", () => {
  it("carries the page, query included, as Login's `from`", () => {
    expect(loginHrefFrom("/m/abc123")).toBe("/login?from=%2Fm%2Fabc123");
    expect(loginHrefFrom("/facts/9?tab=memes")).toBe("/login?from=%2Ffacts%2F9%3Ftab%3Dmemes");
    expect(loginHrefFrom("/account/deletion")).toBe("/login?from=%2Faccount%2Fdeletion");
  });

  it("carries nothing from the home page, a sign-in-flow page, or an unsafe target", () => {
    expect(loginHrefFrom("/")).toBe("/login");
    for (const p of ["/login", "/login?from=%2Fx", "/forgot-password", "/reset-password/tok", "/check-email", "/verify-email?t=1", "/onboard?returnTo=%2F"]) {
      expect(loginHrefFrom(p)).toBe("/login");
    }
    expect(loginHrefFrom("//evil.com")).toBe("/login");
    expect(loginHrefFrom("https://evil.com/x")).toBe("/login");
  });
});

/**
 * The class, not the four links the issue listed: no sign-in link outside the
 * sign-in flow may drop the page it was opened from. A bare "/login" (or a
 * `returnTo`, which Login never reads) is allowed only on the flow's own pages.
 */
describe("every sign-in entry point carries the page you were on", () => {
  const SRC = join(__dirname, "..");
  const FLOW_PAGES = new Set(["pages/ForgotPassword.tsx", "pages/CheckEmail.tsx", "pages/Login.tsx"]);
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it("has no bare or returnTo-style sign-in link outside the sign-in flow", () => {
    // Only shapes that navigate: route lists and comments that name /login are not links.
    const bare = /(setLocation\(|navigate\(|href=\{?|location\.href\s*=\s*|location\.assign\()\s*["'`]\/login(\?returnTo=[^"'`]*)?["'`]/;
    const offenders = sources(SRC)
      .map((f) => relative(SRC, f).replace(/\\/g, "/"))
      .filter((rel) => !FLOW_PAGES.has(rel) && rel !== "App.tsx")
      .filter((rel) => bare.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});
