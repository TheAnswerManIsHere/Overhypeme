import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

const allowedOrigin = "https://app.example.com";

async function getApp() {
  const mod = await import("../app.js");
  return mod.default;
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
