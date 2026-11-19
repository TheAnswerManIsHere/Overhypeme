/**
 * The development preview gate (launch Phase 14, increment 3): in a Replit
 * workspace, a request through the public preview address needs the dev
 * preview key; a direct local request does not; the published deployment is
 * never gated; with no key configured the preview is refused outright.
 *
 * The middleware takes its environment as an argument, so no process state is
 * touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import express from "express";
import request from "supertest";

import { devPreviewGate, isGatedEnvironment } from "../middlewares/devPreviewGate.js";

const DEV_DOMAIN = "abc-00-xyz.spock.replit.dev";
const KEY = "k3y-for-tests-0123456789";

function appWith(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(devPreviewGate(env));
  app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
  app.post("/api/auth/dev-admin-login", (_req, res) => res.json({ ok: true }));
  app.get("/api/auth/dev-admin-login", (_req, res) => res.send("<script>/* login page */</script>"));
  app.post("/api/auth/dev-admin-login/x", (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/register", (_req, res) => res.json({ ok: true }));
  app.post("/api/stripe/webhook", (_req, res) => res.json({ received: true }));
  return app;
}

const workspace = { NODE_ENV: "development", REPLIT_DEV_DOMAIN: DEV_DOMAIN, DEV_PREVIEW_KEY: KEY };

/** A request as Replit's preview proxy delivers it. */
function viaPreview(req: request.Test): request.Test {
  return req.set("Host", DEV_DOMAIN).set("X-Forwarded-For", "203.0.113.9");
}

describe("devPreviewGate", () => {
  it("is active only in a Replit workspace", () => {
    assert.equal(isGatedEnvironment(workspace), true);
    assert.equal(isGatedEnvironment({ ...workspace, REPLIT_DEPLOYMENT: "1" }), false);
    assert.equal(isGatedEnvironment({ ...workspace, NODE_ENV: "production" }), false);
    assert.equal(isGatedEnvironment({ NODE_ENV: "development" }), false);
  });

  it("refuses the dev admin shortcut through the preview without the key, by either method", async () => {
    const app = appWith(workspace);
    const post = await viaPreview(request(app).post("/api/auth/dev-admin-login"));
    assert.equal(post.status, 403);
    assert.equal(post.body.error, "dev_preview_locked");
    assert.equal((await viaPreview(request(app).get("/api/auth/dev-admin-login?returnTo=/admin"))).status, 403);
  });

  it("leaves every other dev address open without the key (David, Q21: 1)", async () => {
    const app = appWith(workspace);
    assert.equal((await viaPreview(request(app).get("/api/healthz"))).status, 200);
    assert.equal((await viaPreview(request(app).post("/api/auth/register"))).status, 200);
    assert.equal((await viaPreview(request(app).post("/api/stripe/webhook"))).status, 200);
    assert.equal((await viaPreview(request(app).post("/api/auth/dev-admin-login/x"))).status, 200);
  });

  it("admits the shortcut with the key by header or by cookie", async () => {
    const app = appWith(workspace);
    assert.equal((await viaPreview(request(app).post("/api/auth/dev-admin-login")).set("X-Dev-Preview-Key", KEY)).status, 200);
    assert.equal((await viaPreview(request(app).get("/api/auth/dev-admin-login?returnTo=/admin")).set("Cookie", `dev_preview_key=${KEY}`)).status, 200);
  });

  it("refuses a wrong key, including one of a different length", async () => {
    const app = appWith(workspace);
    assert.equal((await viaPreview(request(app).post("/api/auth/dev-admin-login")).set("X-Dev-Preview-Key", KEY.replace("k", "K"))).status, 403);
    assert.equal((await viaPreview(request(app).post("/api/auth/dev-admin-login")).set("X-Dev-Preview-Key", "short")).status, 403);
  });

  it("never reads a proxied request as local, whatever its Host", async () => {
    const app = appWith(workspace);
    const res = await request(app).post("/api/auth/dev-admin-login").set("Host", "localhost:8080").set("X-Forwarded-For", "203.0.113.9");
    assert.equal(res.status, 403);
  });

  it("lets a direct local request reach the shortcut without the key", async () => {
    const app = appWith(workspace);
    assert.equal((await request(app).post("/api/auth/dev-admin-login").set("Host", "localhost:8080")).status, 200);
    assert.equal((await request(app).post("/api/auth/dev-admin-login").set("Host", "127.0.0.1:8080")).status, 200);
  });

  it("refuses the shortcut and the unlock call through the preview when no key is configured", async () => {
    const app = appWith({ NODE_ENV: "development", REPLIT_DEV_DOMAIN: DEV_DOMAIN });
    assert.equal((await viaPreview(request(app).post("/api/auth/dev-admin-login")).set("X-Dev-Preview-Key", "")).status, 403);
    assert.equal((await viaPreview(request(app).post("/api/dev-preview-gate")).set("X-Dev-Preview-Key", "")).status, 403);
    assert.equal((await viaPreview(request(app).get("/api/healthz"))).status, 200);
  });

  it("sets a partitioned cookie for a keyed unlock call, and only then", async () => {
    const app = appWith(workspace);
    const ok = await viaPreview(request(app).post("/api/dev-preview-gate")).set("X-Dev-Preview-Key", KEY);
    assert.equal(ok.status, 204);
    const cookie = String(ok.headers["set-cookie"] ?? "");
    assert.match(cookie, /dev_preview_key=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Partitioned/);
    const bad = await viaPreview(request(app).post("/api/dev-preview-gate")).set("X-Dev-Preview-Key", "nope");
    assert.equal(bad.status, 403);
    assert.equal(bad.headers["set-cookie"], undefined);
  });

  it("never takes the key from an address: the old ?key= link is refused", async () => {
    const app = appWith(workspace);
    const res = await viaPreview(request(app).get(`/api/dev-preview-gate?key=${KEY}`));
    assert.equal(res.status, 403);
    assert.equal(res.headers["set-cookie"], undefined);
  });

  it("does nothing in the published deployment", async () => {
    const app = appWith({ ...workspace, REPLIT_DEPLOYMENT: "1" });
    assert.equal((await viaPreview(request(app).post("/api/auth/dev-admin-login"))).status, 200);
  });
});
