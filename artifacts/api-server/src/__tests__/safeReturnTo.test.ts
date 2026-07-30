/**
 * Unit tests for `getSafeReturnTo` — the OAuth-callback / dev-admin-login
 * redirect-target validator.
 *
 * This function had no test coverage until PR #292's review surfaced that its
 * client-side twin (`artifacts/overhype-me/src/lib/safe-return-to.ts`) missed
 * a dot-segment normalization case, and this file shares the identical
 * mechanism — same bug, same fix, same test cases apply here too.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getSafeReturnTo } from "../lib/safeReturnTo.js";

describe("getSafeReturnTo", () => {
  it("passes through a plain same-origin path", () => {
    assert.equal(getSafeReturnTo("/facts/123"), "/facts/123");
    assert.equal(getSafeReturnTo("/profile"), "/profile");
    assert.equal(getSafeReturnTo("/"), "/");
  });

  it("preserves query and hash on an otherwise safe path", () => {
    assert.equal(getSafeReturnTo("/facts/123?tab=memes"), "/facts/123?tab=memes");
    assert.equal(getSafeReturnTo("/facts/123#comments"), "/facts/123#comments");
    assert.equal(getSafeReturnTo("/f?a=1#b"), "/f?a=1#b");
  });

  it("collapses to / for an absent or non-string value", () => {
    assert.equal(getSafeReturnTo(null), "/");
    assert.equal(getSafeReturnTo(undefined), "/");
    assert.equal(getSafeReturnTo(""), "/");
    assert.equal(getSafeReturnTo(42), "/");
  });

  it("rejects absolute URLs on another origin (open redirect)", () => {
    assert.equal(getSafeReturnTo("https://evil.com"), "/");
    assert.equal(getSafeReturnTo("http://evil.com/path"), "/");
    assert.equal(getSafeReturnTo("https://evil.com/facts/1"), "/");
  });

  it("rejects protocol-relative URLs", () => {
    assert.equal(getSafeReturnTo("//evil.com"), "/");
    assert.equal(getSafeReturnTo("//evil.com/facts/1"), "/");
  });

  it("rejects non-path schemes (script injection)", () => {
    assert.equal(getSafeReturnTo("javascript:alert(1)"), "/");
    assert.equal(getSafeReturnTo("JavaScript:alert(1)"), "/");
    assert.equal(getSafeReturnTo("data:text/html,<script>alert(1)</script>"), "/");
    assert.equal(getSafeReturnTo("vbscript:msgbox(1)"), "/");
  });

  // WHATWG URL parsing treats backslashes in a special-scheme URL as forward
  // slashes and strips tab/newline entirely — so a value can pass a naive
  // `startsWith("//")` check and still resolve to a foreign host. The
  // hostname re-check after parsing is what catches these.
  it("rejects backslash and control-character smuggling past the prefix check", () => {
    assert.equal(getSafeReturnTo("/\\evil.com"), "/");
    assert.equal(getSafeReturnTo("/\\/evil.com"), "/");
    assert.equal(getSafeReturnTo("/\t/evil.com"), "/");
    assert.equal(getSafeReturnTo("/\n/evil.com"), "/");
    assert.equal(getSafeReturnTo("/\r/evil.com"), "/");
    assert.equal(getSafeReturnTo("/\t\\evil.com"), "/");
  });

  it("keeps a stripped control character that leaves the path same-origin", () => {
    assert.equal(getSafeReturnTo("/\tevil.com"), "/evil.com");
  });

  it("rejects a value that does not start with a slash", () => {
    assert.equal(getSafeReturnTo("facts/123"), "/");
    assert.equal(getSafeReturnTo("evil.com"), "/");
    assert.equal(getSafeReturnTo(" /facts/123"), "/");
  });

  // Codex review, PR #292: RFC 3986 dot-segment removal means a value can
  // fail both the "//" prefix check and the hostname check, yet still
  // resolve to a protocol-relative path once WHATWG URL normalizes it.
  it("rejects a value whose dot-segment-normalized path becomes protocol-relative", () => {
    assert.equal(getSafeReturnTo("/a/..//evil.com"), "/");
    assert.equal(getSafeReturnTo("/..//evil.com"), "/");
    assert.equal(getSafeReturnTo("/a/../..//evil.com"), "/");
    assert.equal(getSafeReturnTo("/a/b/../..//evil.com"), "/");
  });

  it("still resolves a dot-segment path that normalizes to a same-origin path", () => {
    assert.equal(getSafeReturnTo("/a/../evil.com"), "/evil.com");
    assert.equal(getSafeReturnTo("/facts/../profile"), "/profile");
  });
});
