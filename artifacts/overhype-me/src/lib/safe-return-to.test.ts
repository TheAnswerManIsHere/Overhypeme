import { describe, it, expect } from "vitest";
import { getSafeReturnTo } from "./safe-return-to";

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
});
