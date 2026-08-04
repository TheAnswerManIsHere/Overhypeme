import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";

const allowedOrigin = "https://app.example.com";

// A fresh instance per call (never a cached singleton) — createApp() reads
// ALLOWED_ORIGINS at call time, so each test's beforeEach-set value is
// always the one actually in effect, regardless of what any other test file
// in the same --test-isolation=none shard imported or set before this one.
async function getApp() {
  return createApp();
}

describe("CSRF + Origin protection", () => {
  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = allowedOrigin;
  });

  it("allows same-site cookie-auth mutation with matching CSRF token", async () => {
    const app = await getApp();
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Origin", allowedOrigin)
      .set("X-CSRF-Token", "token-1")
      .set("Cookie", ["sid=fake-session", "csrf_token=token-1"]);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it("rejects cookie-auth mutation with missing CSRF token", async () => {
    const app = await getApp();
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Origin", allowedOrigin)
      .set("Cookie", ["sid=fake-session", "csrf_token=token-1"]);

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "Invalid CSRF token" });
  });

  it("rejects disallowed origin before route logic executes", async () => {
    const app = await getApp();
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Origin", "https://evil.example.com")
      .set("X-CSRF-Token", "token-1")
      .set("Cookie", ["sid=fake-session", "csrf_token=token-1"]);

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "Origin not allowed" });
  });
});
