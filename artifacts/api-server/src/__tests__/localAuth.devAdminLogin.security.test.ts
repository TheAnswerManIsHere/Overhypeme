/**
 * Security regression for C1 — the dev-admin-login backdoor is fail-closed.
 *
 * `POST/GET /api/auth/dev-admin-login` mints a bootstrap-admin session for any
 * caller, so it MUST be inert unless explicitly enabled for a non-production
 * preview (`ENABLE_DEV_ADMIN_LOGIN=true` AND not production). These tests prove:
 *   - the gate predicate's env matrix (default off; prod always off);
 *   - the returnTo sanitizer (open-redirect / script-injection);
 *   - end-to-end: when DISABLED the route mints NO session and 404s; when
 *     ENABLED it grants and the redirect target is sanitized.
 *
 * The route registration is unconditional; `handleDevAdminLogin` guards at
 * request time, so toggling the env var per request is sufficient (no module
 * re-import needed). App-level CORS/origin-exemption gating (app.ts) is
 * additional defense-in-depth and is not exercised here.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import localAuthRouter from "../routes/localAuth.js";
import { isDevAdminLoginEnabled } from "../lib/devAdminLogin.js";
import { getSafeReturnTo } from "../lib/safeReturnTo.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const ADMIN_EMAIL = "overhypeme+admin@gmail.com";
const ENV_KEYS = ["ENABLE_DEV_ADMIN_LOGIN", "NODE_ENV", "REPLIT_DEPLOYMENT", "REPLIT_DEV_DOMAIN", "DEV_PREVIEW_KEY"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function enable() {
  process.env.ENABLE_DEV_ADMIN_LOGIN = "true";
  delete process.env.NODE_ENV;
  delete process.env.REPLIT_DEPLOYMENT;
  delete process.env.REPLIT_DEV_DOMAIN;
  delete process.env.DEV_PREVIEW_KEY;
}
function disable() {
  delete process.env.ENABLE_DEV_ADMIN_LOGIN;
  delete process.env.NODE_ENV;
  delete process.env.REPLIT_DEPLOYMENT;
  delete process.env.REPLIT_DEV_DOMAIN;
  delete process.env.DEV_PREVIEW_KEY;
}

describe("isDevAdminLoginEnabled — fail-closed env matrix", () => {
  it("OFF by default (no flag)", () => {
    disable();
    assert.equal(isDevAdminLoginEnabled(), false);
  });
  it("ON only with the explicit flag in a non-prod env", () => {
    enable();
    assert.equal(isDevAdminLoginEnabled(), true);
  });
  it("flag set to anything but 'true' is OFF", () => {
    disable();
    process.env.ENABLE_DEV_ADMIN_LOGIN = "1";
    assert.equal(isDevAdminLoginEnabled(), false);
    process.env.ENABLE_DEV_ADMIN_LOGIN = "yes";
    assert.equal(isDevAdminLoginEnabled(), false);
  });
  it("NEVER on in production, even with the flag set", () => {
    enable();
    process.env.NODE_ENV = "production";
    assert.equal(isDevAdminLoginEnabled(), false);
    delete process.env.NODE_ENV;
    process.env.REPLIT_DEPLOYMENT = "1";
    assert.equal(isDevAdminLoginEnabled(), false);
  });
});

describe("getSafeReturnTo — open-redirect / injection guard", () => {
  it("collapses unsafe values to '/'", () => {
    for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)", "\\\\evil", "/\\evil.com", 42, null, undefined, ""]) {
      assert.equal(getSafeReturnTo(bad as unknown), "/", `should reject ${JSON.stringify(bad)}`);
    }
  });
  it("keeps a same-origin path (with query + hash)", () => {
    assert.equal(getSafeReturnTo("/admin"), "/admin");
    assert.equal(getSafeReturnTo("/admin?tab=x#y"), "/admin?tab=x#y");
  });
});

describe("dev-admin-login route — inert when disabled", () => {
  const app = () => buildTestApp({ kind: "unauthenticated" }, localAuthRouter);

  it("GET 404s and mints NO session cookie when disabled (default)", async () => {
    disable();
    const res = await request(app()).get("/api/auth/dev-admin-login");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Not found");
    assert.equal(res.headers["set-cookie"], undefined, "must not set a session cookie when disabled");
  });

  it("POST 404s and mints NO session cookie when disabled (default)", async () => {
    disable();
    const res = await request(app()).post("/api/auth/dev-admin-login").send({});
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Not found");
    assert.equal(res.headers["set-cookie"], undefined);
  });

  it("stays disabled in production even when the flag is set", async () => {
    enable();
    process.env.NODE_ENV = "production";
    const res = await request(app()).post("/api/auth/dev-admin-login").send({});
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Not found");
    assert.equal(res.headers["set-cookie"], undefined);
  });
});

describe("dev-admin-login route — grants when enabled (non-prod preview)", () => {
  const app = () => buildTestApp({ kind: "unauthenticated" }, localAuthRouter);
  let adminPreexisted = false;
  let originalActive = false;
  let originalIsAdmin = false;

  before(async () => {
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, ADMIN_EMAIL)).limit(1);
    if (existing) {
      adminPreexisted = true;
      originalActive = existing.isActive;
      originalIsAdmin = existing.isAdmin;
      await db.update(usersTable).set({ isActive: true, isAdmin: true }).where(eq(usersTable.id, existing.id));
    } else {
      await db.insert(usersTable).values({ id: `t_c1_${randomUUID()}`, email: ADMIN_EMAIL, isActive: true, isAdmin: true });
    }
  });
  after(async () => {
    if (adminPreexisted) {
      await db.update(usersTable).set({ isActive: originalActive, isAdmin: originalIsAdmin }).where(eq(usersTable.email, ADMIN_EMAIL));
    } else {
      await db.delete(usersTable).where(eq(usersTable.email, ADMIN_EMAIL));
    }
  });

  it("POST grants an admin session (200) and issues a fresh session cookie", async () => {
    enable();
    const res = await request(app()).post("/api/auth/dev-admin-login").send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.email, ADMIN_EMAIL);
    // The e2e admin-login flow asserts on `user.email` — lock that shape.
    assert.equal(res.body.user?.email, ADMIN_EMAIL);
    assert.ok(res.headers["set-cookie"], "a fresh session cookie must be issued");
  });

  it("GET sanitizes returnTo — an off-site target collapses to '/'", async () => {
    enable();
    const res = await request(app()).get("/api/auth/dev-admin-login?returnTo=//evil.com/x");
    assert.equal(res.status, 200);
    const html = res.text;
    assert.match(html, /window\.location\.replace\("\/"\)/, "off-site returnTo must be sanitized to '/'");
    assert.doesNotMatch(html, /evil\.com/, "the off-site host must never appear in the redirect");
  });

  // PR #1072 round 1: a literal address comparison ahead of the router let
  // the shortcut through by another spelling. The key is now checked on the
  // handler, so every spelling Express routes here needs it.
  describe("through the public dev preview, every spelling Express routes here needs the key", () => {
    const PREVIEW = "abc-00-xyz.spock.replit.dev";
    const KEY = "k3y-for-tests-0123456789";
    const SPELLINGS = [
      "/api/auth/dev-admin-login",
      "/api/auth/dev-admin-login/",
      "/api/auth/DEV-ADMIN-LOGIN",
      "/API/AUTH/dev-admin-login",
      "/Api/Auth/Dev-Admin-Login/",
    ];
    function onPreview() {
      enable();
      process.env.REPLIT_DEV_DOMAIN = PREVIEW;
      process.env.DEV_PREVIEW_KEY = KEY;
    }
    const via = (r: request.Test) => r.set("Host", PREVIEW).set("X-Forwarded-For", "203.0.113.9");

    it("refuses GET, POST and HEAD without the key, with no session cookie", async () => {
      onPreview();
      for (const p of SPELLINGS) {
        for (const method of ["get", "post", "head"] as const) {
          const res = await via(request(app())[method](p));
          assert.equal(res.status, 403, `${method.toUpperCase()} ${p}`);
          assert.equal(res.headers["set-cookie"], undefined, `${method.toUpperCase()} ${p} must not set a cookie`);
        }
      }
    });

    it("refuses a wrong key, and every spelling when no key is configured", async () => {
      onPreview();
      for (const p of SPELLINGS) {
        assert.equal((await via(request(app()).post(p)).set("X-Dev-Preview-Key", "wrong")).status, 403, p);
      }
      delete process.env.DEV_PREVIEW_KEY;
      for (const p of SPELLINGS) {
        assert.equal((await via(request(app()).post(p)).set("X-Dev-Preview-Key", "")).status, 403, p);
      }
    });

    it("grants with the key, by header or by cookie", async () => {
      onPreview();
      for (const p of SPELLINGS) {
        assert.equal((await via(request(app()).post(p)).set("X-Dev-Preview-Key", KEY).send({})).status, 200, `header ${p}`);
        assert.equal((await via(request(app()).get(p)).set("Cookie", `dev_preview_key=${KEY}`)).status, 200, `cookie ${p}`);
      }
    });

    it("needs no key for a direct local request", async () => {
      onPreview();
      assert.equal((await request(app()).post("/api/auth/dev-admin-login").set("Host", "localhost:8080").send({})).status, 200);
    });
  });

  it("GET honors a safe same-origin returnTo", async () => {
    enable();
    const res = await request(app()).get("/api/auth/dev-admin-login?returnTo=/admin");
    assert.equal(res.status, 200);
    assert.match(res.text, /window\.location\.replace\("\/admin"\)/);
  });
});
