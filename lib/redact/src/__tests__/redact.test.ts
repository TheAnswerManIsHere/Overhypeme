import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubObject, scrubUrl, SENSITIVE_KEY_PATTERNS } from "../index.js";

describe("SENSITIVE_KEY_PATTERNS", () => {
  it("exports an array of RegExp", () => {
    assert.ok(Array.isArray(SENSITIVE_KEY_PATTERNS));
    assert.ok(SENSITIVE_KEY_PATTERNS.every((p) => p instanceof RegExp));
  });
});

describe("scrubObject", () => {
  it("redacts password fields", () => {
    const result = scrubObject({ password: "s3cr3t", name: "alice" }) as Record<string, unknown>;
    assert.equal(result.password, "[Filtered]");
    assert.equal(result.name, "alice");
  });

  it("redacts token fields", () => {
    const result = scrubObject({ accessToken: "abc123", id: 1 }) as Record<string, unknown>;
    assert.equal(result.accessToken, "[Filtered]");
    assert.equal(result.id, 1);
  });

  it("redacts email fields", () => {
    const result = scrubObject({ userEmail: "alice@example.com" }) as Record<string, unknown>;
    assert.equal(result.userEmail, "[Filtered]");
  });

  it("redacts nested sensitive keys", () => {
    const result = scrubObject({
      user: { password: "hunter2", role: "admin" },
    }) as { user: Record<string, unknown> };
    assert.equal(result.user.password, "[Filtered]");
    assert.equal(result.user.role, "admin");
  });

  it("passes through non-sensitive keys unchanged", () => {
    const result = scrubObject({ username: "bob", score: 42 }) as Record<string, unknown>;
    assert.equal(result.username, "bob");
    assert.equal(result.score, 42);
  });

  it("handles arrays at top level", () => {
    const result = scrubObject([{ token: "t" }, { name: "x" }]) as Array<Record<string, unknown>>;
    assert.equal(result[0].token, "[Filtered]");
    assert.equal(result[1].name, "x");
  });

  it("handles null and primitives gracefully", () => {
    assert.equal(scrubObject(null), null);
    assert.equal(scrubObject(42), 42);
    assert.equal(scrubObject("hello"), "hello");
  });

  it("stops recursing beyond depth 6", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { secret: "x" } } } } } } } };
    const result = scrubObject(deep) as Record<string, unknown>;
    assert.ok(result.a !== null);
  });
});

describe("scrubUrl", () => {
  it("redacts sensitive query params in absolute URLs", () => {
    const result = scrubUrl("https://example.com/path?token=abc&name=bob");
    assert.ok(result.includes("token=%5BFiltered%5D"));
    assert.ok(result.includes("name=bob"));
  });

  it("redacts sensitive query params in relative URLs", () => {
    const result = scrubUrl("/api/login?password=hunter2&redirect=/home");
    assert.ok(result.startsWith("/api/login"));
    assert.ok(result.includes("password=%5BFiltered%5D"));
    assert.ok(result.includes("redirect=%2Fhome"));
  });

  it("returns the original URL unchanged when no sensitive params", () => {
    const url = "https://example.com/search?q=hello&page=2";
    assert.equal(scrubUrl(url), url);
  });

  it("returns the original string if the URL cannot be parsed", () => {
    const bad = "not a valid url ://";
    assert.equal(scrubUrl(bad), bad);
  });

  it("accepts a custom base for relative URLs", () => {
    const result = scrubUrl("/path?apiKey=secret", "https://myapp.example.com");
    assert.ok(result.includes("apiKey=%5BFiltered%5D"));
  });
});
