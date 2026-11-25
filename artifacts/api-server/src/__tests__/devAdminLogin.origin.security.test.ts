/**
 * Launch Phase 15, increment 2 — the dev admin shortcut has no origin-check
 * exemption and no permissive CORS, so a page on another site cannot sign a
 * browser in. Exercised through the real app (`createApp()`), whose origin and
 * CSRF middleware the route used to escape while enabled.
 *
 * What stays working: a direct request with no Origin (the acceptance driver,
 * E2E's `context.request.post`) and a same-origin request from the SPA.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import request from "supertest";

import { createApp } from "../app.js";
import { BOOTSTRAP_ADMIN_EMAIL as ADMIN_EMAIL, seedBootstrapAdmin, sessionIdFromResponse } from "./helpers/devAdminFixture.js";

const ALLOWED = "https://app.example.com";
const EVIL = "https://evil.example.com";
const PATH = "/api/auth/dev-admin-login";
const ENV_KEYS = ["ENABLE_DEV_ADMIN_LOGIN", "NODE_ENV", "REPLIT_DEPLOYMENT", "REPLIT_DEV_DOMAIN", "DEV_PREVIEW_KEY", "ALLOWED_ORIGINS"] as const;

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ENABLE_DEV_ADMIN_LOGIN = "true";
  delete process.env.NODE_ENV;
  delete process.env.REPLIT_DEPLOYMENT;
  delete process.env.REPLIT_DEV_DOMAIN;
  delete process.env.DEV_PREVIEW_KEY;
  process.env.ALLOWED_ORIGINS = ALLOWED;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("dev admin shortcut — origin and CORS (Phase 15, increment 2)", () => {
  let restoreAdmin: () => Promise<void>;
  before(async () => { restoreAdmin = await seedBootstrapAdmin(); });
  after(async () => { await restoreAdmin(); });

  it("refuses a POST from another site, before any session is minted", async () => {
    for (const origin of [EVIL, "null"]) {
      const res = await request(createApp()).post(PATH).set("Origin", origin).send({});
      assert.equal(res.status, 403, `Origin ${origin}`);
      assert.deepEqual(res.body, { error: "Origin not allowed" });
      assert.equal(sessionIdFromResponse(res), undefined, `Origin ${origin} must not set a session cookie`);
    }
  });

  it("gives another site's preflight no CORS permission", async () => {
    const res = await request(createApp())
      .options(PATH)
      .set("Origin", EVIL)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
  });

  it("grants a same-origin POST from the app, with the token in the body", async () => {
    const res = await request(createApp()).post(PATH).set("Origin", ALLOWED).send({});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers["access-control-allow-origin"], ALLOWED);
    const sid = sessionIdFromResponse(res);
    assert.ok(sid);
    assert.equal(res.body.token, sid);
  });

  it("keeps the automation seam: a direct POST with no Origin signs in", async () => {
    const res = await request(createApp()).post(PATH).send({});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.user?.email, ADMIN_EMAIL);
    assert.ok(sessionIdFromResponse(res));
  });

  it("holds a caller that already has a session cookie to the CSRF check, like any write", async () => {
    const refused = await request(createApp())
      .post(PATH)
      .set("Origin", ALLOWED)
      .set("Cookie", ["sid=some-existing-session", "csrf_token=t-1"])
      .send({});
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, { error: "Invalid CSRF token" });

    const granted = await request(createApp())
      .post(PATH)
      .set("Origin", ALLOWED)
      .set("Cookie", ["sid=some-existing-session", "csrf_token=t-1"])
      .set("X-CSRF-Token", "t-1")
      .send({});
    assert.equal(granted.status, 200, granted.text);
  });

  it("no GET mints a session through the full app", async () => {
    const res = await request(createApp()).get(`${PATH}?returnTo=/admin`);
    assert.notEqual(res.status, 200);
    assert.equal(sessionIdFromResponse(res), undefined);
    assert.doesNotMatch(res.text, /auth_token|<script/i);
  });
});
